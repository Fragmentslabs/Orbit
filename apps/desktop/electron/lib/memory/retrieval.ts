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
import { embedTexts, noiseFloorFor, vectorsById, type TurnEmbedder } from './embedding'

/**
 * Memory retrieval for the turn: merges what the semantic and the
 * lexical search find, and decides what goes into the context (and how).
 *
 * The parameters below were calibrated in the versioned benchmark
 * (electron/lib/memory/bench) on the development split and checked on
 * the evaluation one — see docs/contextual-memory.md. They are the ones from Bekko a8m, which
 * is the model that stayed.
 */
// The lexical search comes in as support, not as a competing source: at equal weight, a
// single-token match ties with the best semantic one and drags R@1 down. The
// definition lives in `@shared/memory-select`, the same one the tool search uses.
export const RETRIEVAL: RetrievalParams = PRODUCTION_RETRIEVAL

export const SELECTION: SelectionParams = {
  threshold: 'collection',
  injectCos: 0.64,
  pointerCos: 0.42,
  noiseQuantile: 1,
  injectDelta: 0.22,
  pointerDelta: 0,
  minMargin: 0,
  // Lexical coverage that, added to a middling cosine, unlocks injection. It is what
  // holds precision without relying on the cosine alone.
  lexInjectCoverage: 0.7,
  lexPointerCoverage: 2,
  maxInject: 3,
  maxPointers: 2,
  gap: 0.1,
  maxInjectChars: 600,
}

export interface MemoryContext {
  /** Memories injected in full into the turn context */
  inject: Memory[]
  /** Pointer only: the model opens it with memory_open when it makes sense */
  pointers: Memory[]
  /** The semantic search did not run (missing model, dead worker or empty index) */
  degraded: boolean
  /** Thresholds used — they go to the log and to the diagnostics UI */
  thresholds: { inject: number; pointer: number }
  /** Cosine of the best candidate (debugging) */
  topCos: number | null
}

export interface RetrieveInput {
  /** The user message, as it came */
  message: string
  /** Previous turns (most recent last), for messages that do not explain themselves */
  recent?: ChatTurn[]
  /** Eligible pool in the scope (chat or project) */
  pool: Memory[]
  /** Attached documents, by id — what is inside the `.md` counts too */
  docs?: Map<string, string>
  /** Embeds the query. The turn passes one shared with the other searches so the message is vectorized once. */
  embed?: TurnEmbedder
}

/** The retrieval never embeds on its own: the caller hands the embedder in (or this default). */
const defaultEmbed: TurnEmbedder = async (text) => {
  try {
    const [vec] = await embedTexts([text])
    return vec ?? null
  } catch {
    return null
  }
}

/** An empty pool or an empty message retrieves nothing. */
function usable(text: string): boolean {
  return text.trim().length > 0
}

/**
 * Retrieves the turn's memory context. Never throws: memory is auxiliary
 * context and a failure here cannot take down the conversation.
 */
export async function retrieveMemoryContext(input: RetrieveInput): Promise<MemoryContext | null> {
  const pool = input.pool.filter((m) => usable(m.text))
  if (pool.length === 0 || !usable(input.message)) return null

  const byId = new Map(pool.map((m) => [m.id, m]))
  const lexical = new Bm25Index(pool.map((m) => lexicalDocOf(m, input.docs?.get(m.id))))
  const vectors = await vectorsById()
  const hasVectors = vectors.size > 0

  // Safe fallback: without a semantic index (model not downloaded, dead worker,
  // freshly created pool) the usual lexical search still finds what
  // shares a term with the message. Pointers only: without a cosine there is no way
  // to claim high confidence, and injecting text into the context without evidence is
  // exactly what this work exists to avoid.
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
    const queryVec = hasVectors ? await (input.embed ?? defaultEmbed)(semantic) : null
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

    // Short message that found nothing: worth looking at the previous turn. A change
    // of subject does not inherit the context because the test requires the isolated
    // message to have failed.
    if (!found && input.recent?.length && needsContextRetry(input.message, true, false)) {
      const contextual = contextualQuery(input.message, input.recent)
      const retry = await run(contextual.semantic, contextual.lexical)
      if (retry.selection.inject.length || retry.selection.pointers.length) result = retry
    }

    const toMemory = (id: string) => byId.get(id)
    const picked = result.selection.inject
      .map((c) => toMemory(c.id))
      .filter((m): m is Memory => Boolean(m))
    // A memory too long for the budget is not discarded: it becomes a pointer.
    // The whole content is still one memory_open away.
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
    console.error('[memory] retrieval failed:', err)
    // Safe fallback: the usual lexical search, with no threshold at all.
    const legacy = lexical.search(input.message, 3)
    const pointers = legacy.map((hit) => byId.get(hit.id)).filter((m): m is Memory => Boolean(m))
    return { inject: [], pointers, degraded: true, thresholds: { inject: 1, pointer: 0 }, topCos: null }
  }
}

/**
 * Memory block for the turn. Split into two levels on purpose: the full text
 * only for what is trustworthy; the rest becomes a line with id and title,
 * which the model opens with memory_open if needed.
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
// Turn suggestions: id + metadata, never content
// ---------------------------------------------------------------------------

/** Metadata of a suggested memory — the content stays in the pool. */
export interface MemorySuggestion {
  id: string
  kind: Memory['kind']
  area?: Memory['area']
  category?: Memory['category']
}

export interface SuggestInput extends RetrieveInput {
  /** Ids already in the system prompt block: they do not repeat here. */
  exclude?: readonly string[]
  /** How many suggestions at most (default 3). */
  max?: number
}

/**
 * Turn suggestions: **id and metadata only**.
 *
 * Solves the discovery problem without passing the fact along. The block says that
 * something exists in that area (`general/preferences`), and the model opens it with
 * memory_open only if that would change the answer — the content never enters
 * the prompt on its own.
 *
 * The threshold here is looser than the one for text injection on purpose: a wrong
 * guess costs an ignored line, not a contaminated answer. That is
 * why it pays to accept what the cosine only "finds similar", as long as the memory
 * is at the top of the fused ranking.
 */
export async function suggestMemories(input: SuggestInput): Promise<MemorySuggestion[]> {
  const skip = new Set(input.exclude ?? [])
  const pool = input.pool.filter((m) => usable(m.text) && !skip.has(m.id))
  if (pool.length === 0 || !usable(input.message)) return []

  const byId = new Map(pool.map((m) => [m.id, m]))
  const lexical = new Bm25Index(pool.map((m) => lexicalDocOf(m, input.docs?.get(m.id))))
  const vectors = await vectorsById()

  const rank = async (semantic: string, lexicalQuery: string): Promise<MemorySuggestion[]> => {
    // Model went down → null: carry on with the lexical path, no semantic suggestion.
    const queryVec = vectors.size > 0 ? await (input.embed ?? defaultEmbed)(semantic) : null
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
    // Short message that found nothing: the previous turn disambiguates it.
    if (input.recent?.length && needsContextRetry(input.message, true, false)) {
      const contextual = contextualQuery(input.message, input.recent)
      return await rank(contextual.semantic, contextual.lexical)
    }
    return []
  } catch (err) {
    console.error('[memory] suggestions failed:', err)
    return []
  }
}

/**
 * Suggestions block, delimited and labelled as a system guess.
 *
 * The label is not decoration: without it the model reads the ids as if the user
 * had said them. And the warning that the content is NOT loaded is what separates
 * "something exists" from "the fact is this".
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

/** Text that goes into a memory's index (re-exported for the tests and the UI). */
export { buildRetrievalText }
