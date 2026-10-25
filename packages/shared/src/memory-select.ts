/**
 * Seleção de memórias para o contexto: candidatos (semântico + lexical + fusão)
 * e a política de dois níveis. Funções puras — o mesmo código roda no app e no
 * benchmark (electron/lib/memory/bench), então o que se mede é o que se entrega.
 */

import { Bm25Index, dot, lexTokens, reciprocalRankFusion } from "./memory-retrieval"

// ---------------------------------------------------------------------------
// Candidatos
// ---------------------------------------------------------------------------

export type RetrievalMode = "semantic" | "lexical" | "hybrid"

export interface RetrievalParams {
  mode: RetrievalMode
  /** Quantos candidatos cada fonte entrega à fusão */
  semK: number
  lexK: number
  /** Constante k do RRF */
  rrfK: number
  /** Pesos de cada lista no RRF */
  semWeight: number
  lexWeight: number
  /**
   * Cobertura mínima (fração do IDF da consulta) para um acerto lexical entrar
   * na fusão. Em 0, entra qualquer documento com um token em comum — o que num
   * acervo grande é ruído: "de", "para" e um nome de cidade casam com dezenas de
   * memórias. Quem decide o número é a calibração (bench/analysis.ts).
   */
  lexMinCoverage: number
}

export const DEFAULT_RETRIEVAL: RetrievalParams = {
  mode: "hybrid",
  semK: 20,
  lexK: 20,
  rrfK: 60,
  semWeight: 1,
  lexWeight: 1,
  lexMinCoverage: 0,
}

/**
 * Fusão de produção — a MESMA constante que o bench usa (bench/policy.ts
 * reexporta daqui), para que o que se mede e o que se entrega sejam o mesmo
 * número. Peso lexical pequeno e corte de cobertura: com peso igual o RRF
 * perde ~30 pp de R@1 (medido); com o corte, empata com o semântico e mantém
 * o identificador exato no topo, que é o que o BM25 faz de melhor.
 */
export const PRODUCTION_RETRIEVAL: RetrievalParams = {
  ...DEFAULT_RETRIEVAL,
  semWeight: 1,
  lexWeight: 0.1,
  lexMinCoverage: 0.5,
}

export interface Candidate {
  id: string
  /** Cosseno com a consulta (null quando não há vetor ou modo lexical) */
  cos: number | null
  semRank: number | null
  /** BM25 e fração do IDF da consulta que o documento cobre (0..1) */
  bm25: number
  coverage: number
  lexRank: number | null
  /** Score da fusão (RRF) — só para ordenar; a decisão usa os sinais brutos */
  fused: number
}

export interface RetrievalInput {
  /** Embedding da consulta; null/undefined ⇒ só lexical */
  queryVec?: ArrayLike<number> | null
  /** Texto original da consulta (busca lexical) */
  lexicalQuery: string
  vectors: ReadonlyMap<string, ArrayLike<number>>
  lexical: Bm25Index
}

export function retrieveCandidates(input: RetrievalInput, params: RetrievalParams = DEFAULT_RETRIEVAL): Candidate[] {
  const useSem = params.mode !== "lexical" && input.queryVec != null
  const useLex = params.mode !== "semantic" || !useSem

  const cosById = new Map<string, number>()
  let semOrder: string[] = []
  if (useSem) {
    const scored: Array<[string, number]> = []
    for (const [id, vec] of input.vectors) scored.push([id, dot(input.queryVec!, vec)])
    scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    for (const [id, cos] of scored) cosById.set(id, cos)
    semOrder = scored.slice(0, params.semK).map(([id]) => id)
  }

  const qIdf = useLex ? queryIdfMass(input.lexical, input.lexicalQuery) : 0
  const rawLex = useLex ? input.lexical.search(input.lexicalQuery, Math.max(params.lexK, 50)) : []
  // A cobertura é o quanto do IDF da consulta o documento cobre; o corte tira o
  // acerto de um token só antes de ele disputar posição na fusão.
  const lexHits =
    params.lexMinCoverage > 0 && qIdf > 0
      ? rawLex.filter((hit) => hit.score / qIdf >= params.lexMinCoverage)
      : rawLex
  const lexById = new Map(lexHits.map((hit, i) => [hit.id, { ...hit, rank: i }]))
  const lexOrder = lexHits.slice(0, params.lexK).map((h) => h.id)

  const lists = []
  if (useSem) lists.push({ ids: semOrder, weight: params.semWeight })
  if (useLex) lists.push({ ids: lexOrder, weight: params.lexWeight })
  const fused = reciprocalRankFusion(lists, params.rrfK)

  return fused.map(({ id, score }) => {
    const lex = lexById.get(id)
    const semRank = semOrder.indexOf(id)
    return {
      id,
      cos: cosById.has(id) ? cosById.get(id)! : null,
      semRank: semRank >= 0 ? semRank : null,
      bm25: lex?.score ?? 0,
      coverage: lex && qIdf > 0 ? Math.min(1, lex.score / qIdf) : 0,
      lexRank: lex ? lex.rank : null,
      fused: score,
    }
  })
}

/** Teto aproximado do BM25 para a consulta (todos os termos casando): normaliza a cobertura. */
function queryIdfMass(index: Bm25Index, query: string): number {
  return index.queryMass(query)
}

// ---------------------------------------------------------------------------
// Piso de ruído por acervo
// ---------------------------------------------------------------------------

/**
 * Perguntas genéricas, sem relação com a vida de ninguém. Rodadas contra o
 * acervo do usuário, mostram até onde o cosseno chega "por acaso" naquele
 * conjunto de memórias — que varia com o tamanho, o idioma e o tom do acervo.
 * Nenhuma delas aparece no benchmark (cases.json); o conjunto foi escrito à
 * parte para a calibração não ver os casos de avaliação.
 */
export const NOISE_PROBES: string[] = [
  "Qual é a capital da Austrália?",
  "Quanto é 45 dividido por 9?",
  "Explique a diferença entre vírus e bactéria.",
  "Escreva um poema curto sobre a chuva.",
  "Como faço para ordenar uma lista em Python?",
  "Quem pintou a Mona Lisa?",
  "Traduza 'obrigado' para o italiano.",
  "O que causa as marés?",
  "Resuma a história do Império Romano em poucas linhas.",
  "Qual a diferença entre TCP e UDP?",
  "What is the tallest mountain in the world?",
  "Explain how photosynthesis works.",
  "Write a limerick about a cat.",
  "How many ounces are in a pound?",
  "What is the difference between a list and a tuple in Python?",
  "Who wrote Pride and Prejudice?",
  "Give me three tips to write a clear email.",
  "Why is the sky blue?",
  "What does HTTP status 404 mean?",
  "Summarize the plot of Romeo and Juliet.",
  "¿Cuántos planetas tiene el sistema solar?",
  "Escribe una función que invierta una cadena.",
  "¿Qué es la inflación?",
  "¿Quién descubrió América?",
  "日本で一番長い川は?",
  "光合成とは何ですか?",
  "Кто написал «Войну и мир»?",
  "Объясни, что такое простое число.",
  "Wie funktioniert ein Elektromotor?",
  "Quelle est la formule de l'eau ?",
  "Bom dia, tudo certo?",
  "Thanks a lot!",
  "Can you rephrase this sentence to sound more formal?",
  "Corrija a ortografia deste texto, por favor.",
  "What is a good name for a bakery?",
  "Me dê uma ideia de nome para um aplicativo de receitas.",
]

export interface NoiseFloor {
  /** Maior cosseno de cada sonda contra o acervo, em ordem crescente */
  tops: number[]
}

export function noiseFloorOf(
  probeVecs: ArrayLike<number>[],
  vectors: ReadonlyMap<string, ArrayLike<number>>,
): NoiseFloor {
  const tops = probeVecs.map((p) => {
    let best = -1
    for (const vec of vectors.values()) best = Math.max(best, dot(p, vec))
    return best
  })
  return { tops: tops.sort((a, b) => a - b) }
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)))
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

// ---------------------------------------------------------------------------
// Política de dois níveis
// ---------------------------------------------------------------------------

export interface SelectionParams {
  /**
   * Como o limiar de cosseno é obtido:
   *  - "absolute": `injectCos` / `pointerCos` valem como estão
   *  - "acervo": piso de ruído do acervo (quantil das sondas) + `injectDelta` / `pointerDelta`
   */
  threshold: "absolute" | "acervo"
  injectCos: number
  pointerCos: number
  noiseQuantile: number
  injectDelta: number
  pointerDelta: number
  /** Distância mínima entre o 1º e o 2º candidato para injetar só pelo cosseno (0 = ignora) */
  minMargin: number
  /** Cobertura lexical que, somada a um cosseno de ponteiro, basta para injetar (>1 = desliga) */
  lexInjectCoverage: number
  /** Cobertura lexical que sozinha (sem cosseno alto) basta para um ponteiro */
  lexPointerCoverage: number
  maxInject: number
  maxPointers: number
  /** Além do 1º, só entram candidatos a até `gap` de cosseno do 1º */
  gap: number
  /** Teto de caracteres de uma memória injetada (o resto fica atrás do memory_open) */
  maxInjectChars: number
}

export const DEFAULT_SELECTION: SelectionParams = {
  threshold: "acervo",
  injectCos: 0.6,
  pointerCos: 0.5,
  noiseQuantile: 1,
  injectDelta: 0.05,
  pointerDelta: 0,
  minMargin: 0,
  lexInjectCoverage: 2,
  lexPointerCoverage: 2,
  maxInject: 3,
  maxPointers: 2,
  gap: 0.08,
  maxInjectChars: 600,
}

export type Tier = "inject" | "pointer"

export interface Selected extends Candidate {
  tier: Tier
}

export interface Selection {
  inject: Selected[]
  pointers: Selected[]
  /** Limiares efetivamente usados (para depuração e para os relatórios) */
  thresholds: { inject: number; pointer: number }
}

export function selectForContext(
  candidates: Candidate[],
  noise: NoiseFloor | undefined,
  params: SelectionParams = DEFAULT_SELECTION,
): Selection {
  let injectT = params.injectCos
  let pointerT = params.pointerCos
  if (params.threshold === "acervo" && noise && noise.tops.length > 0) {
    const floor = quantile(noise.tops, params.noiseQuantile)
    injectT = floor + params.injectDelta
    pointerT = floor + params.pointerDelta
  }

  const bySem = candidates.filter((c) => c.cos != null).sort((a, b) => b.cos! - a.cos!)
  const top = bySem[0]
  const second = bySem[1]
  const margin = top && second ? top.cos! - second.cos! : top ? 1 : 0

  // Empate no topo é sinal de ambiguidade, não de relevância: se o 1º não está
  // claramente à frente do 2º, nenhum dos dois merece injeção automática — os
  // dois viram ponteiro. Sem `minMargin` (0), o critério fica desligado.
  const ambiguous = params.minMargin > 0 && top != null && second != null && margin < params.minMargin

  const inject: Selected[] = []
  const pointers: Selected[] = []
  const used = new Set<string>()

  // Candidatos em ordem de cosseno (os sem vetor, só léxicos, vão depois).
  const ordered = [...bySem, ...candidates.filter((c) => c.cos == null)]
  for (const c of ordered) {
    if (used.has(c.id)) continue
    const nearTop = !top || c.cos == null || top.cos! - c.cos <= params.gap
    const cos = c.cos ?? -1
    const strongCos = cos >= injectT && !ambiguous
    const lexBoost = cos >= pointerT && c.coverage >= params.lexInjectCoverage
    if ((strongCos || lexBoost) && nearTop && inject.length < params.maxInject) {
      inject.push({ ...c, tier: "inject" })
      used.add(c.id)
      continue
    }
    const plausible = cos >= pointerT || c.coverage >= params.lexPointerCoverage
    if (plausible && pointers.length < params.maxPointers) {
      pointers.push({ ...c, tier: "pointer" })
      used.add(c.id)
    }
  }
  return { inject, pointers, thresholds: { inject: injectT, pointer: pointerT } }
}

/** Quantos tokens lexicais a consulta tem (para decidir se vale a busca lexical). */
export function queryTokenCount(query: string): number {
  return lexTokens(query).length
}
