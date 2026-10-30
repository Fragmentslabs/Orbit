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
 * Memory routine (Settings → Memories): looks back at the user's conversations
 * and turns what repeats into memory.
 *
 *  - Daily capture: reads only the USER's messages in the window and asks the auxiliary
 *    model for up to 3 patterns. Each one starts as a PROPOSED seasonal item — it does not
 *    enter the prompt or the search until it is accepted on the memories screen.
 *  - Weekly consolidation: promotes to general the seasonals already accepted that came back
 *    on different days, measured by text similarity. It deletes nothing.
 *
 * The window is "since the last capture", never a fixed time of day: if the app stayed
 * closed for three days, the next round takes the whole interval (capped), instead
 * of losing what happened after midnight.
 */

const STATE_KEY = 'memory/routine'
const HOUR = 60 * 60 * 1000

/** One capture per day, with slack in case the app was closed at the wrong time. */
const CAPTURE_EVERY = 20 * HOUR
/** Maximum window looked back, even if the last capture is old. */
const CAPTURE_WINDOW = 48 * HOUR
const CONSOLIDATE_EVERY = 6 * 24 * HOUR
/** Only consolidates what was created in the last few days — old items have already decided for themselves. */
const CONSOLIDATE_WINDOW = 8 * 24 * HOUR
/** An idle day has no pattern to extract. */
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
- At most ${MAX_ITEMS}. Fewer is better than filler. If nothing qualifies, answer {"memories":[]}.
- category is one of: preference (how they like things done), convention (a rule of the house), decision (a choice already made), standard (a checklist to follow).

Answer with JSON ONLY, no prose and no markdown fences:
{"memories":[{"text":"...","category":"preference"}]}`

export interface RoutineState {
  lastCaptureAt?: number
  lastConsolidateAt?: number
}

/** What is due to run now. Pure, so it can be tested without a clock. */
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

/** Words with weight; the rest (articles, short prepositions) is just noise. */
function tokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4)
  return new Set(words)
}

/** Jaccard of the two word sets — 0..1. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.size || !tb.size) return 0
  let common = 0
  for (const w of ta) if (tb.has(w)) common++
  return common / (ta.size + tb.size - common)
}

/** Extracts the JSON from the answer (the model insists on wrapping it in ``` or prose). */
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
  text: string
  category?: string
}

function candidates(raw: unknown): Candidate[] {
  const obj = (raw ?? {}) as { memories?: unknown; memorias?: unknown }
  // `memorias` is the legacy field name, from answers given before the standard was English.
  const list = obj.memories ?? obj.memorias
  const array = Array.isArray(list) ? list : Array.isArray(raw) ? raw : []
  return array
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>
      const text = typeof row.text === 'string' ? row.text : typeof row.texto === 'string' ? row.texto : ''
      const category = typeof row.category === 'string' ? row.category : typeof row.categoria === 'string' ? row.categoria : undefined
      return { text: text.trim(), category }
    })
    .filter((c) => c.text.length >= 20 && c.text.length <= 280)
    .slice(0, MAX_ITEMS)
}

/** The user's own messages in the window — what they asked for and corrected. */
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
    blocks.push(`## ${session.title || 'Conversation'}\n${lines.join('\n')}`)
    if (chars >= MAX_INPUT_CHARS) break
  }
  return { digest: blocks.join('\n\n').slice(0, MAX_INPUT_CHARS), count }
}

/** Calls the auxiliary model. With no model chosen, the routine does not run. */
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
      /* the error shows up in the stream and is handled below */
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

/** Writes the day's proposals. Returns how many were saved. */
async function capture(state: RoutineState, now: number): Promise<number> {
  const from = Math.max(state.lastCaptureAt ?? 0, now - CAPTURE_WINDOW)
  const { digest, count } = await readDigest(from, now)
  if (count < MIN_MESSAGES || !digest) return 0

  const found = await askModel(digest)
  let saved = 0
  for (const item of found) {
    const category = CATEGORIES.find((c) => c === item.category) ?? 'preference'
    await save({
      text: item.text,
      kind: 'seasonal',
      category,
      // The proposal is born in the chat (where the user talks) and is only valid there until someone
      // — the user — decides it is worth more than that.
      scope: 'chat',
      weight: PROPOSAL_WEIGHT,
      proposed: true,
      tags: ['routine'],
    })
    saved++
  }
  return saved
}

/**
 * Promotes to general the accepted seasonals that came back on different days. It does not
 * delete duplicates: what does not become a preference expires on its own.
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

/** One round — called by the scheduler every 6h; each phase limits itself. */
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
    // Marks the window as read even with no proposals: an idle day does not repeat itself.
    next.lastCaptureAt = now
    if (saved) console.log(`[memory] routine proposed ${saved} memory(ies)`)
  }
  if (due.consolidate) {
    const promoted = await consolidate(now)
    next.lastConsolidateAt = now
    if (promoted) console.log(`[memory] routine consolidated ${promoted} memory(ies)`)
  }
  await writeJson(STATE_KEY, next)
}
