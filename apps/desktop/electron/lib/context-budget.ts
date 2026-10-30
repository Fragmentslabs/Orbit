import path from 'node:path'
import type { ModelMessage } from 'ai'
import type { CatalogModel } from '@shared/chat'
import { parseFileView, parseInspection } from './bash-inspect'

/**
 * Context budget WITHIN the turn.
 *
 * Compaction (compaction.ts) only reaches the persisted history BETWEEN turns,
 * and `toModelMessages` already discards the old ToolParts — that is, what it
 * summarizes is the smallest part of what goes to the model. What blows up the context is
 * the tool loop of the turn in progress: the SDK resends every tool call and
 * every result on each step, and with hundreds of steps that grows without a ceiling
 * (a real turn came to request 3.4M tokens on a 1M model).
 *
 * This module cuts that accumulation in `prepareStep` — the only point where the
 * turn's messages pass before becoming a request.
 */

/** Rough estimate, without a tokenizer: the average of a text in UTF-8. */
const CHARS_PER_TOKEN = 4

/**
 * Absolute context ceiling, regardless of the `limit.context` announced by the
 * catalog. Models of 1M+ would only trigger the relative cuts near ~1M,
 * leaving the conversation to routinely operate with hundreds of thousands of tokens
 * of history — expensive and slow long before becoming an error. Shared with
 * compaction so that both cuts speak of the same ceiling.
 */
export const ABSOLUTE_CONTEXT_CAP = 300_000

/** Reserve for the model's answer. */
const OUTPUT_RESERVE_CAP = 32_000
/** Reserve for the system prompt + tool definitions, which do not pass
 *  through here (the SDK assembles the request after prepareStep). */
const PROMPT_RESERVE = 30_000
const MIN_BUDGET = 16_000

/** Fixed size charged per binary attachment: a 1MB PNG becomes ~1.5k tokens at the
 *  provider, but ~250k characters of base64 — counting them by character would make the
 *  budget think it overflowed and discard half a turn needlessly. */
const BINARY_PART_CHARS = 6_000

/**
 * Tool results always preserved, no matter how tight the
 * budget is: it is the model's workbench right now. Discarding the
 * last ones would make the agent lose what it just read and re-read it in a loop.
 */
const KEEP_RECENT_RESULTS = 10

/**
 * Last-resort floor: when even discarding everything old the turn does not
 * fit, the cut moves over the recent ones and stops here. Losing what the model
 * just read is bad; a request the provider refuses entirely is worse — and
 * that was exactly what happened before this module existed.
 */
const MIN_KEPT_RESULTS = 2

/**
 * Fraction of the budget from which repeated calls start being
 * discarded. Below that the turn is small and there is no point in touching the context:
 * no saving justifies changing what the model sees in a turn that fits comfortably.
 */
const SUPERSEDE_THRESHOLD = 0.5

/** Strings inside the input of a discarded call above this are cut
 *  — the `content` of a `write` of a large file stays in the context forever,
 *  and once the result is discarded it is no longer good for anything. */
const MAX_KEPT_INPUT_STRING = 400

/**
 * Tools whose repetition with the SAME arguments makes the previous result
 * redundant. Only idempotent reads enter: `bash` runs a command (the
 * second `git status` does not invalidate the first as a record of what happened) and
 * `write`/`edit` have side effects.
 */
const IDEMPOTENT_TOOLS = new Set(['read', 'ls', 'glob', 'grep', 'code_search', 'code_outline', 'code_refs'])

/**
 * WORKING ceiling of the turn, below the safety ceiling (`contextBudget`).
 * The safety ceiling only prevents the request the provider refuses; in real
 * data long turns ran 200–470k tokens per step, and each step
 * resends everything — the heaviest 10% of turns were 66% of the input. Going past
 * this, what is old leaves in a batch (see BATCH_TARGET).
 */
const WORKING_CONTEXT_CAP = 100_000

/**
 * How far the batch cut goes down, as a fraction of the working ceiling. Discarding
 * only what is needed to fit would change the middle of the context on every step — and every
 * change invalidates the provider's prefix cache from there on. Going well
 * below the ceiling, the context grows back intact for many steps before
 * the next cut.
 */
const BATCH_TARGET = 0.6

/**
 * Computer Use tools whose result is a screen observation. An observation
 * is only valid until the next COMPLETE tree of the same app: from there back the indexes
 * and the state it shows are no longer true, and each step of the loop
 * resent it — with the screenshot, when there was one. The diffs (tools/computer.ts) rely
 * on the last complete tree, so it and what comes after stay.
 */
const OBSERVATION_TOOLS = new Set(['cu_observe', 'cu_computer', 'cu_batch', 'cu_query'])
const OBSERVATION_APP = /^App: .*\bpid (\d+)\)/m
const FULL_TREE = /^Tree \(\d+ elements/m
/**
 * Expired observations leave together, not one per step: every discard changes
 * the middle of the context and invalidates the provider's prefix cache from there on.
 */
const STALE_OBSERVATION_BATCH = 3
const MAX_KEPT_SUMMARY = 500

/** `read` without `limit` shows up to this (MAX_READ_LINES in tools/files.ts). */
const READ_DEFAULT_LINES = 2000

/** Prefix of the text that replaces a discarded result — it serves as a sentinel
 *  to avoid reprocessing, step after step, what was already cut. */
const DROPPED_MARK = '[SYSTEM: tool output dropped'

/** Separator of the deduplication key: serialized JSON never contains a raw line
 *  break, so there is no way for one argument to forge another's key. */
const KEY_SEPARATOR = '\n'

/**
 * Step ceiling per turn. The context cut above already prevents the tool loop from
 * blowing the window, so this here is a guard for cost and for a false loop: a
 * model with a small context has nothing to do with 300 trips to the provider.
 */
const MAX_STEPS_CEILING = 300
const MAX_STEPS_FLOOR = 120
const TOKENS_PER_STEP = 3_400

export function maxStepsFor(model: CatalogModel | undefined): number {
  const context = model?.limit?.context
  if (!context) return MAX_STEPS_FLOOR
  const scaled = Math.round(Math.min(context, ABSOLUTE_CONTEXT_CAP * 4) / TOKENS_PER_STEP)
  return Math.max(MAX_STEPS_FLOOR, Math.min(MAX_STEPS_CEILING, scaled))
}

/** How many tokens the turn's messages may take before the cut comes in. */
export function contextBudget(model: CatalogModel | undefined): number {
  const context = Math.min(model?.limit?.context || ABSOLUTE_CONTEXT_CAP, ABSOLUTE_CONTEXT_CAP)
  const output = Math.min(model?.limit?.output || OUTPUT_RESERVE_CAP, OUTPUT_RESERVE_CAP)
  return Math.max(context - output - PROMPT_RESERVE, MIN_BUDGET)
}

/** Ceiling from which the batch cut comes in — never above the safety one. */
export function workingBudget(model: CatalogModel | undefined): number {
  return Math.min(contextBudget(model), WORKING_CONTEXT_CAP)
}

function safeChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object'
}

function partType(part: unknown): string | undefined {
  return isRecord(part) && typeof part.type === 'string' ? part.type : undefined
}

/** Characters of a tool output, not counting an attachment's base64. */
function outputChars(output: unknown): number {
  if (!isRecord(output)) return 0
  if (output.type === 'content' && Array.isArray(output.value)) {
    return output.value.reduce<number>((sum, item) => sum + partChars(item), 0)
  }
  if (typeof output.value === 'string') return output.value.length
  return safeChars(output)
}

function partChars(part: unknown): number {
  if (typeof part === 'string') return part.length
  if (!isRecord(part)) return 0
  const type = partType(part)
  if (type === 'file' || type === 'image') return BINARY_PART_CHARS
  if (type === 'tool-result') return outputChars(part.output)
  return safeChars(part)
}

/** Size of what goes to the model, in tokens. It overestimates markup and underestimates
 *  languages outside latin-1, but the error is small next to the order of magnitude
 *  that matters here (tens of thousands of tokens). */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0
  for (const message of messages) {
    if (typeof message.content === 'string') chars += message.content.length
    else if (Array.isArray(message.content)) {
      for (const part of message.content) chars += partChars(part)
    }
  }
  return Math.round(chars / CHARS_PER_TOKEN)
}

function isDropped(part: Record<string, unknown>): boolean {
  const output = part.output
  return (
    isRecord(output) &&
    output.type === 'text' &&
    typeof output.value === 'string' &&
    output.value.startsWith(DROPPED_MARK)
  )
}

interface ResultSlot {
  /** `${message index}:${part index}` — positional identity, because
   *  the toolCallId may come empty from parts sanitized by normalizeMessages. */
  at: string
  toolCallId: string
  toolName: string
  chars: number
  /** Start of the result text — `read` and `write` say there the absolute
   *  path they resolved, which the relative input does not say. */
  head: string
  /** Tool error or bash with a non-zero exit code */
  failed: boolean
  /** Bash output with the middle cut (tools/shell.ts) — it covers no range */
  partial: boolean
  /** Computer Use observation: from which app, whether it brings the whole tree and what the action did before it */
  observation: { pid: number; full: boolean; summary: string } | null
}

/** The text of an output — in one with an image, the text part. */
function outputText(output: Record<string, unknown>): string {
  if (typeof output.value === 'string') return output.value
  if (output.type === 'content' && Array.isArray(output.value)) {
    return output.value
      .map((item) => (isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : ''))
      .join('\n')
  }
  return ''
}

function observationOf(toolName: string, text: string): ResultSlot['observation'] {
  if (!OBSERVATION_TOOLS.has(toolName)) return null
  const app = OBSERVATION_APP.exec(text)
  if (!app) return null
  const summary = text.slice(0, app.index).trim()
  return {
    pid: Number(app[1]),
    full: FULL_TREE.test(text),
    summary: summary.length > MAX_KEPT_SUMMARY ? `${summary.slice(0, MAX_KEPT_SUMMARY)}…` : summary,
  }
}

function collectCalls(messages: ModelMessage[]): Map<string, unknown> {
  const calls = new Map<string, unknown>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (partType(part) !== 'tool-call') continue
      const call = part as unknown as Record<string, unknown>
      if (typeof call.toolCallId === 'string') calls.set(call.toolCallId, call.input)
    }
  }
  return calls
}

function collectResults(messages: ModelMessage[]): ResultSlot[] {
  const slots: ResultSlot[] = []
  messages.forEach((message, mi) => {
    if (!Array.isArray(message.content)) return
    message.content.forEach((part, pi) => {
      if (partType(part) !== 'tool-result') return
      const result = part as unknown as Record<string, unknown>
      if (isDropped(result)) return
      const output = isRecord(result.output) ? result.output : {}
      const text = typeof output.value === 'string' ? output.value : ''
      const toolName = typeof result.toolName === 'string' ? result.toolName : ''
      slots.push({
        at: `${mi}:${pi}`,
        toolCallId: typeof result.toolCallId === 'string' ? result.toolCallId : '',
        toolName,
        chars: outputChars(result.output),
        head: text.slice(0, 600),
        failed:
          (typeof output.type === 'string' && output.type.startsWith('error')) ||
          /\(exit code: [^)]*\)\s*$/.test(text.slice(-40)),
        partial: text.includes(OMITTED_MIDDLE_MARK),
        observation: observationOf(toolName, outputText(output)),
      })
    })
  })
  return slots
}

/**
 * What a result represents, to know when a later one makes it
 * redundant:
 * - `query`: idempotent read; the same key repeated replaces the previous one.
 * - `file`: a stretch of a file (`read`, `cat`, `sed -n`, `head`); a later stretch
 *   of the SAME file that covers it replaces it.
 * - `overwrite`: a `write` of the whole file; nothing before it about that
 *   file remains true.
 */
type ResultView =
  | { kind: 'query'; key: string }
  | { kind: 'file'; path: string; from: number; to: number }
  | { kind: 'overwrite'; path: string }

/** What tools/shell.ts writes in place of the middle of a long output */
const OMITTED_MIDDLE_MARK = 'characters omitted from the middle of the output'

const READ_HEADER = /^<file path="([^"]+)">/
const WRITE_HEADER = /^File written: (.+) \(\d+ characters\)/

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function viewOf(slot: ResultSlot, calls: Map<string, unknown>, directory?: string): ResultView | null {
  if (!slot.toolCallId || !calls.has(slot.toolCallId)) return null
  const input = calls.get(slot.toolCallId)
  if (slot.toolName === 'write') {
    const match = WRITE_HEADER.exec(slot.head)
    return match && !slot.failed ? { kind: 'overwrite', path: match[1] } : null
  }
  if (slot.toolName === 'read') {
    // Text file only: a document (PDF/DOCX) is paged by page, not by line.
    const match = READ_HEADER.exec(slot.head)
    if (match && isRecord(input)) {
      const from = Math.max(1, numberOr(input.offset, 1))
      const lines = Math.min(numberOr(input.limit, READ_DEFAULT_LINES), READ_DEFAULT_LINES)
      return { kind: 'file', path: match[1], from, to: from + Math.max(1, lines) - 1 }
    }
  }
  if (slot.toolName === 'bash') {
    if (!directory || !isRecord(input) || typeof input.command !== 'string') return null
    const inspection = parseInspection(input.command, directory)
    if (!inspection) return null
    const file = parseFileView(inspection)
    if (file) return slot.failed || slot.partial ? null : { kind: 'file', ...file }
    return { kind: 'query', key: `bash${KEY_SEPARATOR}${inspection.cwd}${KEY_SEPARATOR}${inspection.command}` }
  }
  if (!IDEMPOTENT_TOOLS.has(slot.toolName)) return null
  const serialized = safeStringify(input)
  return serialized == null ? null : { kind: 'query', key: `${slot.toolName}${KEY_SEPARATOR}${serialized}` }
}

/** Why a later result makes this one redundant — null when it does not. */
function supersededBy(older: ResultView, newer: ResultView, newerFailed: boolean): DropReason | null {
  if (older.kind === 'query') {
    return newer.kind === 'query' && newer.key === older.key ? 'superseded' : null
  }
  if (older.kind !== 'file' || newer.kind === 'query' || path.normalize(newer.path) !== path.normalize(older.path)) {
    return null
  }
  if (newer.kind === 'overwrite') return 'overwritten'
  return !newerFailed && newer.from <= older.from && newer.to >= older.to ? 'covered' : null
}

type DropReason = 'superseded' | 'covered' | 'overwritten' | 'age' | 'oversized' | 'staleObservation'

function droppedText(toolName: string, chars: number, reason: DropReason, summary = ''): string {
  const tool = toolName || 'tool'
  if (reason === 'staleObservation') {
    // What the action did stays: without it the model loses the history of what it already tried.
    return `${DROPPED_MARK} — an older screen observation of this app; a newer full one is further down and these indices are no longer valid.${summary ? ` What this call did: ${summary}` : ''}]`
  }
  if (reason === 'oversized') {
    return `${DROPPED_MARK} — the \`${tool}\` result (${chars} chars) was too large to fit in the context window on its own. Call it again asking for a narrower result (smaller range, filter, limit).]`
  }
  if (reason === 'superseded') {
    return `${DROPPED_MARK} — this \`${tool}\` call was repeated later in the turn with identical arguments; only the newest result is kept. Look further down for it.]`
  }
  if (reason === 'covered') {
    return `${DROPPED_MARK} — these lines of the file were read again later in the turn; only the newest read is kept. Look further down for it.]`
  }
  if (reason === 'overwritten') {
    return `${DROPPED_MARK} — this file was rewritten later in the turn with \`write\`, so this earlier content is stale.]`
  }
  return `${DROPPED_MARK} — the \`${tool}\` result (${chars} chars) was removed to free up context in this turn. Call the tool again if you still need it.]`
}

/** Shortens long strings in the input of a call whose result was
 *  discarded, preserving the keys: the provider validates the input against the
 *  tool's schema, and an empty object would bring the turn down with a 400. */
function shrinkInput(input: unknown): unknown {
  if (!isRecord(input) || Array.isArray(input)) return input
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > MAX_KEPT_INPUT_STRING) {
      changed = true
      const cut = value.length - MAX_KEPT_INPUT_STRING
      next[key] = `${value.slice(0, MAX_KEPT_INPUT_STRING)}… [+${cut} chars dropped]`
    } else {
      next[key] = value
    }
  }
  return changed ? next : input
}

function rewrite(
  messages: ModelMessage[],
  dropped: Map<string, string>,
  droppedCallIds: Set<string>,
): ModelMessage[] {
  return messages.map((message, mi) => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((part, pi) => {
      const type = partType(part)
      if (type === 'tool-result') {
        const stub = dropped.get(`${mi}:${pi}`)
        if (stub === undefined) return part
        changed = true
        return { ...(part as unknown as Record<string, unknown>), output: { type: 'text', value: stub } }
      }
      if (type === 'tool-call') {
        const call = part as unknown as Record<string, unknown>
        if (typeof call.toolCallId !== 'string' || !droppedCallIds.has(call.toolCallId)) return part
        const input = shrinkInput(call.input)
        if (input === call.input) return part
        changed = true
        return { ...call, input }
      }
      return part
    })
    return changed ? ({ ...message, content } as unknown as ModelMessage) : message
  })
}

/**
 * Cuts the tool loop accumulation until it fits the budget. Returns the SAME
 * reference when nothing changes, so `prepareStep` can answer `{}` and the
 * SDK skips rewriting the messages.
 *
 * Criteria, in this order:
 * 1. Results that a later one makes redundant: the same read repeated
 *    (`read` of the same file three times in a turn is by far the most
 *    common case), a re-read stretch that covers the previous one — through `read` or through
 *    `cat`/`sed -n` in bash — and the file rewritten by `write`.
 * 2. Working ceiling (`softBudget`), when it goes past it: the old leaves in a batch
 *    down to BATCH_TARGET of the ceiling, preserving the last results.
 * 3. Safety ceiling (`budgetTokens`), when it still does not fit: it discards from the
 *    oldest to the newest, and at the limit even the recent ones.
 *
 * What is discarded becomes a line saying what was there and that the tool
 * can be called again — it never disappears silently, otherwise the model concludes that it
 * never read the file. The tool CALLS stay: the call/result pair is required by the
 * providers, and breaking it brings the turn down with a 400.
 */
export interface TrimOptions {
  /** Working ceiling of the batch cut (see workingBudget) */
  softBudget?: number
  /**
   * Turn memory. The SDK hands `prepareStep` the ORIGINAL messages on
   * every step, so without this the cut would be redone from scratch and the batch
   * would slide a little on every step — exactly the change in the middle of the
   * context that the batch exists to avoid. With it, what left stays out,
   * with the same text, and the prefix stays stable between cuts.
   */
  state?: TrimState
  /** Folder where bash runs, to resolve the paths of `cat`/`sed -n` */
  directory?: string
}

export interface TrimState {
  dropped: Map<string, DropReason>
}

export function createTrimState(): TrimState {
  return { dropped: new Map() }
}

export function trimTurnContext(
  messages: ModelMessage[],
  budgetTokens: number,
  options: TrimOptions = {},
): ModelMessage[] {
  const results = collectResults(messages)
  if (results.length === 0) return messages

  const calls = collectCalls(messages)
  const dropped = new Map<string, string>()
  const droppedCallIds = new Set<string>()
  let used = estimateTokens(messages)
  const memoryKey = (slot: ResultSlot) => slot.toolCallId || slot.at

  // The replacement notice is built here, and not in the rewrite, so that the
  // deduction is the REAL size of what was left. Estimating it by a constant
  // left the counter optimistic by a few tokens per discard — with hundreds of
  // discards in a turn, the count closed inside the budget and the request went out
  // outside it, which is exactly the error this module exists to avoid.
  const drop = (slot: ResultSlot, reason: DropReason) => {
    if (dropped.has(slot.at)) return
    const stub = droppedText(slot.toolName, slot.chars, reason, slot.observation?.summary)
    dropped.set(slot.at, stub)
    options.state?.dropped.set(memoryKey(slot), reason)
    if (slot.toolCallId) droppedCallIds.add(slot.toolCallId)
    used -= Math.max(0, Math.round((slot.chars - stub.length) / CHARS_PER_TOKEN))
  }

  // What already left on a previous step stays out, with the same notice.
  if (options.state) {
    for (const slot of results) {
      const reason = options.state.dropped.get(memoryKey(slot))
      if (reason) drop(slot, reason)
    }
  }

  // Expired observations leave without waiting for the budget to tighten: they are not only
  // large, they are false (indexes and state of a screen that has already changed).
  const latestFull = new Map<number, number>()
  results.forEach((slot, i) => {
    if (slot.observation?.full) latestFull.set(slot.observation.pid, i)
  })
  const stale = results.filter((slot, i) => {
    const obs = slot.observation
    return obs !== null && i < (latestFull.get(obs.pid) ?? -1) && !dropped.has(slot.at)
  })
  if (stale.length >= STALE_OBSERVATION_BATCH) for (const slot of stale) drop(slot, 'staleObservation')

  const softBudget = options.softBudget ? Math.min(options.softBudget, budgetTokens) : budgetTokens
  if (used > softBudget * SUPERSEDE_THRESHOLD) {
    const views = results.map((slot) => viewOf(slot, calls, options.directory))
    results.forEach((slot, i) => {
      const older = views[i]
      if (!older || dropped.has(slot.at)) return
      for (let j = results.length - 1; j > i; j--) {
        const newer = views[j]
        const reason = newer && supersededBy(older, newer, results[j].failed)
        if (reason) {
          drop(slot, reason)
          return
        }
      }
    })
  }

  const evict = (keep: number, target = budgetTokens) => {
    for (const slot of results.slice(0, Math.max(0, results.length - keep))) {
      if (used <= target) break
      if (dropped.has(slot.at)) continue
      drop(slot, 'age')
    }
  }
  if (options.softBudget && used > softBudget) evict(KEEP_RECENT_RESULTS, softBudget * BATCH_TARGET)
  evict(KEEP_RECENT_RESULTS)
  // Still does not fit: it moves over the workbench down to the floor. It is not the common
  // case — it happens when a few giant outputs alone already go past the
  // budget —, but it is what guarantees a real ceiling instead of a ceiling that
  // only holds while the turn cooperates.
  evict(MIN_KEPT_RESULTS)
  // The floor protects the workbench, but it cannot protect a result that
  // by itself does not fit: a base64 screenshot of 3.3M characters was the last
  // result of the turn, the floor preserved it and the request went out with 917k tokens
  // on a 1M model. Here the largest leaves first, until it fits.
  if (used > budgetTokens) {
    const bySize = [...results].sort((a, b) => b.chars - a.chars)
    for (const slot of bySize) {
      if (used <= budgetTokens) break
      if (dropped.has(slot.at)) continue
      drop(slot, 'oversized')
    }
  }

  if (dropped.size === 0) return messages
  return rewrite(messages, dropped, droppedCallIds)
}
