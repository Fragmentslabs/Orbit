import type { Memory } from '@shared/memory'
import { Bm25Index, buildRetrievalText, lexicalDocOf } from '@shared/memory-retrieval'
import {
  NOISE_PROBES,
  PRODUCTION_RETRIEVAL,
  retrieveCandidates,
  selectForContext,
  type NoiseFloor,
  type RetrievalParams,
  type SelectionParams,
} from '@shared/memory-select'
import { contextualQuery, isolatedQuery, needsContextRetry, type ChatTurn } from '@shared/memory-query'
import { deriveTitle } from '@shared/memory-retrieval'
import { embedTexts, noiseFloorFor, vectorsById } from './embedding'

/**
 * Recuperação de memórias para o turno: junta o que a busca semântica e a
 * lexical acham, e decide o que entra no contexto (e como).
 *
 * Os parâmetros abaixo foram calibrados no benchmark versionado
 * (electron/lib/memory/bench) sobre o split de desenvolvimento e conferidos no
 * de avaliação — ver docs/memoria-contextual.md. Eles são os do Bekko a8m, que
 * é o modelo que ficou.
 */
// O lexical entra como apoio, não como fonte concorrente: com peso igual, um
// acerto de um token só empata com o melhor semântico e derruba o R@1. A
// definição mora em `@shared/memory-select`, a mesma que a busca do tool usa.
export const RETRIEVAL: RetrievalParams = PRODUCTION_RETRIEVAL

export const SELECTION: SelectionParams = {
  threshold: 'acervo',
  injectCos: 0.64,
  pointerCos: 0.42,
  noiseQuantile: 1,
  injectDelta: 0.22,
  pointerDelta: 0,
  minMargin: 0,
  // Cobertura lexical que, somada a um cosseno médio, libera injeção. É o que
  // segura a precisão sem depender só do cosseno.
  lexInjectCoverage: 0.7,
  lexPointerCoverage: 2,
  maxInject: 3,
  maxPointers: 2,
  gap: 0.1,
  maxInjectChars: 600,
}

export interface MemoryContext {
  /** Memórias injetadas por inteiro no contexto do turno */
  inject: Memory[]
  /** Só o ponteiro: o modelo abre com memory_open quando fizer sentido */
  pointers: Memory[]
  /** A busca semântica não rodou (modelo ausente, worker caído ou índice vazio) */
  degraded: boolean
  /** Limiares usados — vai para o log e para a UI de diagnóstico */
  thresholds: { inject: number; pointer: number }
  /** Cosseno do melhor candidato (depuração) */
  topCos: number | null
}

export interface RetrieveInput {
  /** A mensagem do usuário, como veio */
  message: string
  /** Turnos anteriores (mais recente por último), para mensagens que não se explicam sozinhas */
  recent?: ChatTurn[]
  /** Acervo elegível no escopo (chat ou projeto) */
  pool: Memory[]
  /** Documentos anexados, por id — o que está dentro do `.md` também conta */
  docs?: Map<string, string>
}

/** Um acervo vazio ou uma mensagem sem conteúdo não recupera nada. */
function usable(text: string): boolean {
  return text.trim().length > 0
}

/**
 * Recupera o contexto de memória do turno. Nunca lança: memória é contexto
 * auxiliar e uma falha aqui não pode derrubar a conversa.
 */
export async function retrieveMemoryContext(input: RetrieveInput): Promise<MemoryContext | null> {
  const pool = input.pool.filter((m) => usable(m.text))
  if (pool.length === 0 || !usable(input.message)) return null

  const byId = new Map(pool.map((m) => [m.id, m]))
  const lexical = new Bm25Index(pool.map((m) => lexicalDocOf(m, input.docs?.get(m.id))))
  const vectors = await vectorsById()
  const hasVectors = vectors.size > 0

  // Fallback seguro: sem índice semântico (modelo não baixado, worker caído,
  // acervo recém-criado) a busca lexical de sempre continua achando o que
  // compartilha termo com a mensagem. Só ponteiros: sem cosseno não há como
  // afirmar confiança alta, e injetar texto no contexto sem evidência é
  // exatamente o que este trabalho existe para evitar.
  if (!hasVectors) {
    const hits = lexical.search(input.message, SELECTION.maxPointers)
    const pointers = hits.map((hit) => byId.get(hit.id)).filter((m): m is Memory => Boolean(m))
    return { inject: [], pointers, degraded: true, thresholds: { inject: 1, pointer: 0 }, topCos: null }
  }

  let noise: NoiseFloor | undefined
  if (hasVectors) {
    const tops = await noiseFloorFor(NOISE_PROBES, pool)
    if (tops?.length) noise = { tops }
  }

  const run = async (semantic: string, lexicalQuery: string) => {
    let queryVec: Float32Array | null = null
    if (hasVectors) {
      try {
        const [vec] = await embedTexts([semantic])
        queryVec = vec ?? null
      } catch {
        queryVec = null
      }
    }
    const candidates = retrieveCandidates({ queryVec, lexicalQuery, vectors, lexical }, RETRIEVAL)
    const selection = selectForContext(candidates, noise, SELECTION)
    const top = candidates.reduce<number | null>((best, c) => {
      if (c.cos == null) return best
      return best == null || c.cos > best ? c.cos : best
    }, null)
    return { selection, top }
  }

  try {
    const isolated = isolatedQuery(input.message)
    let result = await run(isolated.semantic, isolated.lexical)
    const found = result.selection.inject.length > 0 || result.selection.pointers.length > 0

    // Mensagem curta que não achou nada: vale olhar o turno anterior. A troca
    // de assunto não herda o contexto porque o teste exige que a mensagem
    // isolada tenha falhado.
    if (!found && input.recent?.length && needsContextRetry(input.message, true, false)) {
      const contextual = contextualQuery(input.message, input.recent)
      const retry = await run(contextual.semantic, contextual.lexical)
      if (retry.selection.inject.length || retry.selection.pointers.length) result = retry
    }

    const toMemory = (id: string) => byId.get(id)
    const picked = result.selection.inject
      .map((c) => toMemory(c.id))
      .filter((m): m is Memory => Boolean(m))
    // Memória longa demais para o orçamento não é descartada: vira ponteiro.
    // O conteúdo inteiro continua a um memory_open de distância.
    const inject = picked.filter((m) => m.text.length <= SELECTION.maxInjectChars)
    const tooLong = picked.filter((m) => m.text.length > SELECTION.maxInjectChars)
    const injectIds = new Set(inject.map((m) => m.id))
    const pointers = [...result.selection.pointers.map((c) => toMemory(c.id)), ...tooLong]
      .filter((m): m is Memory => m != null && !injectIds.has(m.id))
      .slice(0, SELECTION.maxPointers)

    if (!inject.length && !pointers.length) {
      return { inject, pointers, degraded: !hasVectors, thresholds: result.selection.thresholds, topCos: result.top }
    }
    return {
      inject,
      pointers,
      degraded: !hasVectors,
      thresholds: result.selection.thresholds,
      topCos: result.top,
    }
  } catch (err) {
    console.error('[memory] recuperação falhou:', err)
    // Fallback seguro: a busca lexical de sempre, sem limiar nenhum.
    const legacy = lexical.search(input.message, 3)
    const pointers = legacy.map((hit) => byId.get(hit.id)).filter((m): m is Memory => Boolean(m))
    return { inject: [], pointers, degraded: true, thresholds: { inject: 1, pointer: 0 }, topCos: null }
  }
}

/**
 * Bloco de memória do turno. Separado em dois níveis de propósito: o texto
 * inteiro só para o que é confiável; o resto vira uma linha com id e título,
 * que o modelo abre com memory_open se fizer falta.
 */
export function renderMemoryBlock(context: MemoryContext | null): string {
  if (!context || (context.inject.length === 0 && context.pointers.length === 0)) return ''
  const lines: string[] = []
  if (context.inject.length > 0) {
    lines.push(
      'Relevant memories for this message (from the user\'s Brain — use them when they help, do not repeat verbatim):',
    )
    for (const memory of context.inject) {
      const category = memory.category ? `[${memory.category}] ` : ''
      const doc = memory.hasDoc ? ` (attached doc — memory_open ${memory.id})` : ''
      lines.push(`- ${category}${memory.text}${doc}`)
    }
  }
  if (context.pointers.length > 0) {
    lines.push('Possibly relevant (open with memory_open only if it helps):')
    for (const memory of context.pointers) {
      const title = deriveTitle(memory)
      lines.push(`- #${memory.id} — ${title || memory.text.slice(0, 80)}`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Sugestões do turno: id + metadados, nunca conteúdo
// ---------------------------------------------------------------------------

/** Metadados de uma memória sugerida — o conteúdo fica no acervo. */
export interface MemorySuggestion {
  id: string
  kind: Memory['kind']
  area?: Memory['area']
  category?: Memory['category']
}

export interface SuggestInput extends RetrieveInput {
  /** Ids que já estão no bloco do system prompt: não se repetem aqui. */
  exclude?: readonly string[]
  /** Quantas sugestões no máximo (padrão 3). */
  max?: number
}

/**
 * Sugestões do turno: **só id e metadados**.
 *
 * Resolve o problema de descoberta sem passar o fato adiante. O bloco diz que
 * existe algo naquela área (`general/preferences`), e o modelo abre com
 * memory_open apenas se aquilo for mudar a resposta — o conteúdo nunca entra
 * no prompt sozinho.
 *
 * O limiar aqui é mais frouxo que o da injeção de texto de propósito: um
 * palpite errado custa uma linha ignorada, não uma resposta contaminada. Por
 * isso vale aceitar o que o cosseno só "acha parecido", desde que a memória
 * esteja no topo do ranking fundido.
 */
export async function suggestMemories(input: SuggestInput): Promise<MemorySuggestion[]> {
  const skip = new Set(input.exclude ?? [])
  const pool = input.pool.filter((m) => usable(m.text) && !skip.has(m.id))
  if (pool.length === 0 || !usable(input.message)) return []

  const byId = new Map(pool.map((m) => [m.id, m]))
  const lexical = new Bm25Index(pool.map((m) => lexicalDocOf(m, input.docs?.get(m.id))))
  const vectors = await vectorsById()

  const rank = async (semantic: string, lexicalQuery: string): Promise<MemorySuggestion[]> => {
    let queryVec: Float32Array | null = null
    if (vectors.size > 0) {
      try {
        const [vec] = await embedTexts([semantic])
        queryVec = vec ?? null
      } catch {
        queryVec = null // modelo caiu: segue pelo lexical, sem sugestão semântica
      }
    }
    const candidates = retrieveCandidates({ queryVec, lexicalQuery, vectors, lexical }, RETRIEVAL)
    return candidates
      .filter((c) => (c.cos != null && c.cos >= SELECTION.pointerCos) || c.lexRank === 0)
      .slice(0, input.max ?? 3)
      .map((c) => byId.get(c.id))
      .filter((m): m is Memory => Boolean(m))
      .map((m) => ({ id: m.id, kind: m.kind, area: m.area, category: m.category }))
  }

  try {
    const isolated = isolatedQuery(input.message)
    const found = await rank(isolated.semantic, isolated.lexical)
    if (found.length > 0) return found
    // Mensagem curta que não achou nada: o turno anterior desambigua.
    if (input.recent?.length && needsContextRetry(input.message, true, false)) {
      const contextual = contextualQuery(input.message, input.recent)
      return await rank(contextual.semantic, contextual.lexical)
    }
    return []
  } catch (err) {
    console.error('[memory] sugestões falharam:', err)
    return []
  }
}

/**
 * Bloco de sugestões, delimitado e rotulado como palpite do sistema.
 *
 * O rótulo não é enfeite: sem ele o modelo lê os ids como se o usuário os
 * tivesse dito. E o aviso de que o conteúdo NÃO está carregado é o que separa
 * "existe algo" de "o fato é este".
 */
export function renderMemorySuggestions(suggestions: MemorySuggestion[]): string {
  if (suggestions.length === 0) return ''
  return [
    '[memory hints — automatic and unverified]',
    'Possibly relevant memories exist. Their content is NOT loaded. Open one with memory_open only if',
    'it would change your answer; otherwise ignore this block entirely.',
    ...suggestions.map((s) => `- ${s.id} · ${[s.kind, s.area, s.category].filter(Boolean).join('/')}`),
  ].join('\n')
}

/** Texto que entra no índice de uma memória (reexportado para os testes e a UI). */
export { buildRetrievalText }
