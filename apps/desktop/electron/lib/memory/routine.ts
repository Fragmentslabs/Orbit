import { streamText } from 'ai'
import type { ChatMessage, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import type { ProjectCategory } from '@shared/memory'
import { getAppSettings } from '../app-settings'
import { getProvider } from '../catalog'
import { resolveModel } from '../providers'
import { interleavedReasoningField, normalizeMessages } from '../reasoning'
import { listKeys, readJson, writeJson } from '../storage'
import { isExpired } from './domain'
import { list, promote, save } from './service'

/**
 * Rotina de memória (Preferências → Memórias): olha as conversas do usuário para
 * trás e transforma o que se repete em memória.
 *
 *  - Captura diária: lê só as mensagens DO USUÁRIO da janela e pede ao modelo
 *    auxiliar até 3 padrões. Cada um nasce como sazonal PROPOSTA — não entra no
 *    prompt nem na busca até ser aceita na tela de memórias.
 *  - Consolidação semanal: promove a geral as sazonais já aceitas que voltaram
 *    em dias diferentes, medida por semelhança de texto. Não apaga nada.
 *
 * A janela é "desde a última captura", nunca um horário fixo: se o app ficou
 * fechado três dias, a próxima rodada pega o intervalo inteiro (com teto), em
 * vez de perder o que aconteceu depois da meia-noite.
 */

const STATE_KEY = 'memory/routine'
const HOUR = 60 * 60 * 1000

/** Uma captura por dia, com folga para o app ter sido fechado na hora certa. */
const CAPTURE_EVERY = 20 * HOUR
/** Janela máxima olhada para trás, mesmo que a última captura seja antiga. */
const CAPTURE_WINDOW = 48 * HOUR
const CONSOLIDATE_EVERY = 6 * 24 * HOUR
/** Só consolida o que nasceu nos últimos dias — o que é velho já decidiu sozinho. */
const CONSOLIDATE_WINDOW = 8 * 24 * HOUR
/** Dia parado não tem padrão para extrair. */
const MIN_MESSAGES = 6
const MAX_INPUT_CHARS = 12_000
const MAX_ITEMS = 3
const PROPOSAL_WEIGHT = 0.35
const MAX_SESSIONS = 20

const CATEGORIES: ProjectCategory[] = ['preference', 'convention', 'decision', 'standard']

const SYSTEM = `You read one day of an Orbit user's own messages (requests, corrections, decisions) and extract what should be remembered about HOW THEY WORK.

Rules:
- Only durable preferences, conventions, decisions and standards. Skip one-off requests, facts about a specific project, code details, and anything already obvious.
- What REPEATS matters most, and a CORRECTION is the strongest signal of all: it is the user saying the previous behaviour was wrong.
- Write each memory in the user's own language, as ONE short sentence (max 200 characters), self-contained: whoever reads it months later, with no access to this conversation, must understand it.
- At most ${MAX_ITEMS}. Fewer is better than filler. If nothing qualifies, answer {"memorias":[]}.
- categoria is one of: preference (how they like things done), convention (a rule of the house), decision (a choice already made), standard (a checklist to follow).

Answer with JSON ONLY, no prose and no markdown fences:
{"memorias":[{"texto":"...","categoria":"preference"}]}`

export interface RoutineState {
  lastCaptureAt?: number
  lastConsolidateAt?: number
}

/** O que está na hora de rodar agora. Puro, para poder testar sem relógio. */
export function dueActions(
  mode: string,
  state: RoutineState,
  now: number,
): { capture: boolean; consolidate: boolean } {
  const on = mode === 'daily' || mode === 'weekly' || mode === 'daily+weekly'
  if (!on) return { capture: false, consolidate: false }
  return {
    capture:
      (mode === 'daily' || mode === 'daily+weekly') && now - (state.lastCaptureAt ?? 0) >= CAPTURE_EVERY,
    consolidate:
      (mode === 'weekly' || mode === 'daily+weekly') &&
      now - (state.lastConsolidateAt ?? 0) >= CONSOLIDATE_EVERY,
  }
}

/** Palavras com peso; o resto (artigos, preposições curtas) só faz ruído. */
function tokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4)
  return new Set(words)
}

/** Jaccard dos dois conjuntos de palavras — 0..1. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.size || !tb.size) return 0
  let common = 0
  for (const w of ta) if (tb.has(w)) common++
  return common / (ta.size + tb.size - common)
}

/** Extrai o JSON da resposta (o modelo insiste em cercar com ``` ou prosa). */
export function extractJson(text: string): unknown {
  const clean = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1')
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(clean.slice(start, end + 1))
  } catch {
    return null
  }
}

interface Candidate {
  texto: string
  categoria?: string
}

function candidates(raw: unknown): Candidate[] {
  const obj = (raw ?? {}) as { memorias?: unknown }
  const array = Array.isArray(obj.memorias) ? obj.memorias : Array.isArray(raw) ? raw : []
  return array
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>
      const texto = typeof row.texto === 'string' ? row.texto.trim() : ''
      const categoria = typeof row.categoria === 'string' ? row.categoria : undefined
      return { texto, categoria }
    })
    .filter((c) => c.texto.length >= 20 && c.texto.length <= 280)
    .slice(0, MAX_ITEMS)
}

/** As mensagens do próprio usuário na janela — o que ele pediu e corrigiu. */
async function readDigest(from: number, now: number): Promise<{ digest: string; count: number }> {
  const keys = await listKeys(StorageKeys.sessionPrefix)
  const sessions = (await Promise.all(keys.map((k) => readJson<SessionInfo>(k))))
    .filter((s): s is SessionInfo => s !== null && s.updatedAt >= from)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS)

  const blocks: string[] = []
  let count = 0
  let chars = 0
  for (const session of sessions) {
    const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(session.id))) ?? []
    const lines: string[] = []
    for (const message of messages) {
      if (message.role !== 'user' || message.summary) continue
      if (message.createdAt < from || message.createdAt > now) continue
      const text = message.parts
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n')
        .trim()
      if (!text) continue
      count++
      lines.push(`- ${text.slice(0, 600)}`)
      chars += text.length
    }
    if (!lines.length) continue
    blocks.push(`## ${session.title || 'Conversa'}\n${lines.join('\n')}`)
    if (chars >= MAX_INPUT_CHARS) break
  }
  return { digest: blocks.join('\n\n').slice(0, MAX_INPUT_CHARS), count }
}

/** Chama o modelo auxiliar. Sem modelo escolhido, a rotina não roda. */
async function askModel(input: string): Promise<Candidate[]> {
  const { auxModel } = getAppSettings()
  if (!auxModel) return []
  const provider = await getProvider(auxModel.providerId)
  const model = await resolveModel(auxModel.providerId, auxModel.modelId)

  let output = ''
  const stream = streamText({
    model,
    system: SYSTEM,
    messages: normalizeMessages(
      [{ role: 'user', content: input }],
      interleavedReasoningField(provider, auxModel.modelId),
    ),
    onError: () => {
      /* o erro aparece no fluxo e é tratado abaixo */
    },
  })
  for await (const part of stream.fullStream) {
    if (part.type === 'text-delta') {
      output += part.text
      if (output.length > 8000) break
    } else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
  }
  return candidates(extractJson(output))
}

/** Grava as propostas do dia. Devolve quantas entraram. */
async function capture(state: RoutineState, now: number): Promise<number> {
  const from = Math.max(state.lastCaptureAt ?? 0, now - CAPTURE_WINDOW)
  const { digest, count } = await readDigest(from, now)
  if (count < MIN_MESSAGES || !digest) return 0

  const found = await askModel(digest)
  let saved = 0
  for (const item of found) {
    const category = CATEGORIES.find((c) => c === item.categoria) ?? 'preference'
    await save({
      text: item.texto,
      kind: 'seasonal',
      category,
      // A proposta nasce no chat (é onde ele conversa) e só vale lá até alguém
      // — o usuário — decidir que ela vale mais que isso.
      scope: 'chat',
      weight: PROPOSAL_WEIGHT,
      proposed: true,
      tags: ['rotina'],
    })
    saved++
  }
  return saved
}

/**
 * Promove a geral as sazonais aceitas que voltaram em dias diferentes. Não
 * apaga duplicatas: o que não virar preferência expira sozinho.
 */
export async function consolidate(now: number): Promise<number> {
  const pool = (await list()).filter(
    (m) =>
      m.kind === 'seasonal' &&
      !m.proposed &&
      !isExpired(m, now) &&
      m.createdAt >= now - CONSOLIDATE_WINDOW,
  )
  const used = new Set<string>()
  let promoted = 0
  for (const memory of pool) {
    if (used.has(memory.id)) continue
    const cluster = pool.filter(
      (other) =>
        other.id !== memory.id &&
        !used.has(other.id) &&
        new Date(other.createdAt).toDateString() !== new Date(memory.createdAt).toDateString() &&
        tokenSimilarity(memory.text, other.text) >= 0.5,
    )
    if (!cluster.length) continue
    used.add(memory.id)
    for (const other of cluster) used.add(other.id)
    await promote(memory.id)
    promoted++
  }
  return promoted
}

/** Uma rodada — chamada pelo scheduler a cada 6h; cada fase se autolimita. */
export async function runMemoryRoutine(): Promise<void> {
  const { memoryRoutine } = getAppSettings()
  if (memoryRoutine === 'off') return
  const state = (await readJson<RoutineState>(STATE_KEY)) ?? {}
  const now = Date.now()
  const due = dueActions(memoryRoutine, state, now)
  if (!due.capture && !due.consolidate) return

  const next: RoutineState = { ...state }
  if (due.capture) {
    const saved = await capture(state, now)
    // Marca a janela como lida mesmo sem propostas: dia parado não se repete.
    next.lastCaptureAt = now
    if (saved) console.log(`[memory] rotina propôs ${saved} memória(s)`)
  }
  if (due.consolidate) {
    const promoted = await consolidate(now)
    next.lastConsolidateAt = now
    if (promoted) console.log(`[memory] rotina consolidou ${promoted} memória(s)`)
  }
  await writeJson(STATE_KEY, next)
}
