import { generateText, type JSONValue, type LanguageModel } from 'ai'
import type { CatalogModel, ChatMessage, TokenUsage } from '@shared/chat'
import { ABSOLUTE_CONTEXT_CAP } from './context-budget'
import { messageContextText } from './todo-context'

/**
 * Automatic context compaction. The history sent to the model is only text
 * (toModelMessages) — what grows without limit is the accumulation of user/
 * assistant turns. When the REAL tokens of the last answer (usage phase) get
 * close to the model's limit, the old stretch is summarized ONCE and persisted
 * as a synthetic `summary: true` message; toModelMessages then cuts at it.
 */

const RESERVE_OUTPUT_CAP = 16_000
const RESERVE_PADDING = 4_000
/** user/assistant pairs preserved intact at the end of the history */
const TAIL_USER_MESSAGES = 2
/** Guard rail of the summary prompt (~25k tokens) */
const MAX_SUMMARY_INPUT_CHARS = 100_000

export const COMPACT_PROMPT = `You compact a conversation's history to free up context. Produce dense Markdown notes preserving, in this priority order:
1. The user's goal and the task's current state (what's been done, what's left).
2. Decisions made and their reasoning.
3. Files, functions, commands, and values cited (exact paths).
4. Pending items, open errors, and preferences expressed by the user.

For item 1, "what's been done" MUST be grounded in the "[Verified record: ...]" lines, which are measured by the engine from filesystem snapshots — not in the assistant's own prose. Where they disagree, the verified record wins. Summarize their verdicts in your own words with the exact file counts (e.g. "engine-verified: 18 files modified", "engine-verified: no files changed"), WITHOUT quoting the "[Verified record: ...]" line itself — it is internal bookkeeping and must never appear in the summary. Never merge a turn marked "NO file was modified" into a list of completed work.

Write the notes in English — they are internal context for the model, not a message to the user — but keep the user's own words, names, file contents and quoted text verbatim, in their original language.

Omit greetings, discarded attempts, and repetition. Reply with ONLY the summary, no preamble.`

/**
 * Header of the summary message. In English, like all text that goes from the system
 * to the model; the screen does not show it (see SummaryCard), and old summaries with the
 * header in Portuguese still count.
 */
export const SUMMARY_PREFIX = 'Summary of the conversation so far:'

export function findLastSummaryIndex(history: ChatMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].summary) return i
  }
  return -1
}

/**
 * How many compactions the conversation has already had. `compactHistory` INSERTS the summary
 * message and never removes the previous ones (they stay in the storage and are
 * ignored by the toModelMessages cut), so each compaction leaves
 * exactly one summary in the array — the count is the compaction counter.
 */
export function countSummaries(history: ChatMessage[]): number {
  return history.reduce((total, m) => (m.summary ? total + 1 : total), 0)
}

/** Context estimated by the real tokens of the last answer — without a tokenizer.
 * Uses `lastTokens.lastStep` (usage of the last call to the model) when
 * available: it is the real size of the accumulated context, unlike
 * `input`/`output` (sum of all the turn's steps, inflated by
 * tool round-trips). Old messages without `lastStep` fall back to
 * the total, which overestimates the context but never fails to compact. */
export function shouldCompact(
  lastTokens: TokenUsage | undefined,
  model: CatalogModel | undefined,
  estimatedContext = 0,
): boolean {
  if (!model?.limit?.context) return false
  const reserve =
    Math.min(model.limit.output || RESERVE_OUTPUT_CAP, RESERVE_OUTPUT_CAP) + RESERVE_PADDING
  const effectiveContext = Math.min(model.limit.context, ABSOLUTE_CONTEXT_CAP)
  const reported = lastTokens
    ? lastTokens.lastStep
      ? lastTokens.lastStep.input + lastTokens.lastStep.output
      : lastTokens.input + lastTokens.output
    : 0
  // `estimatedContext` is measured on the history itself, without depending on the provider:
  // several gateways return no usage at all, and a turn that failed does not record
  // `tokens` — in both cases the conversation grew forever without ever
  // compacting, because the trigger only looked at what the provider had reported.
  const used = Math.max(reported, estimatedContext)
  if (used === 0) return false
  // One rule, no early threshold: compacting before the window is actually full
  // summarizes while there is still useful context left — paying a summary call to
  // lose detail sooner. The reserve already covers the response.
  return used >= effectiveContext - reserve
}

function textOf(message: ChatMessage): string {
  const text = message.parts
    .filter((p): p is Extract<ChatMessage['parts'][number], { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim()
  // Includes the TODO state (if any) in what goes to the summary — otherwise that
  // information never reaches the compaction prompt (ToolParts are ignored
  // above) and item 1 of COMPACT_PROMPT ("what has already been done, what is left")
  // is left without the most reliable source of that state.
  return messageContextText(message, text)
}

/**
 * Defines the stretch to summarize: from the last summary (inclusive — the previous summary
 * is merged into the new one) up to before the preserved tail. null = nothing to compact.
 */
export function splitForCompaction(
  history: ChatMessage[],
): { old: ChatMessage[]; cutIndex: number } | null {
  const start = Math.max(0, findLastSummaryIndex(history))
  let usersSeen = 0
  let cut = -1
  for (let i = history.length - 1; i >= start; i--) {
    if (history[i].role === 'user') {
      usersSeen++
      if (usersSeen === TAIL_USER_MESSAGES) {
        cut = i
        break
      }
    }
  }
  // At least one complete pair has to be left before the tail for the cost to be worth it
  if (cut < start + 2) return null
  return { old: history.slice(start, cut), cutIndex: cut }
}

/**
 * Text sent to the summary prompt. The stretch starts at the previous summary (see
 * splitForCompaction), and cutting only at the end, as before, discarded that
 * whole summary as soon as the stretch passed the ceiling — the conversation forgot
 * everything that came before the last compaction. The previous summary always enters
 * whole; the ceiling counts only for the new messages, of which the end stays.
 */
export function buildCompactionTranscript(old: ChatMessage[]): string {
  const render = (m: ChatMessage) => {
    const text = textOf(m)
    return text ? `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}` : null
  }
  const previous = old[0]?.summary ? render(old[0]) : null
  const rest = (previous ? old.slice(1) : old)
    .map(render)
    .filter(Boolean)
    .join('\n\n')
  if (!previous) return rest.slice(-MAX_SUMMARY_INPUT_CHARS)
  const budget = Math.max(0, MAX_SUMMARY_INPUT_CHARS - previous.length - 2)
  const tail = budget > 0 ? rest.slice(-budget) : ''
  return tail ? `${previous}\n\n${tail}` : previous
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Summarizes the old stretch and INSERTS the summary message into the history (mutation).
 * Returns the created message, or null when there is nothing to compact.
 */
export async function compactHistory(
  history: ChatMessage[],
  model: LanguageModel,
  providerOptions?: Record<string, Record<string, JSONValue>>,
): Promise<ChatMessage | null> {
  const split = splitForCompaction(history)
  if (!split) return null

  const transcript = buildCompactionTranscript(split.old)
  if (!transcript) return null

  const { text } = await generateText({
    model,
    system: COMPACT_PROMPT,
    prompt: transcript,
    providerOptions,
  })
  if (!text.trim()) return null

  const summaryMessage: ChatMessage = {
    id: newId('msg'),
    role: 'assistant',
    summary: true,
    parts: [
      {
        id: newId('prt'),
        type: 'text',
        text: `${SUMMARY_PREFIX}\n\n${text.trim()}`,
        state: 'done',
      },
    ],
    createdAt: Date.now(),
  }
  history.splice(split.cutIndex, 0, summaryMessage)
  return summaryMessage
}

/**
 * Continuity brief: what a NEW chat needs to know to follow the
 * work without inheriting the whole context. Unlike COMPACT_PROMPT, which
 * compresses the past, this text is the opening of another conversation — it has to
 * make sense on its own.
 */
export const CONTINUATION_PROMPT = `You write the opening note of a NEW chat that continues an older conversation. This note is the only thing the new chat knows about the work so far, so it must stand alone.

Produce dense Markdown with:
1. The goal — what the user is trying to accomplish, in their own words where possible.
2. State — what is done and what is left. "Done" MUST be grounded in the "[Verified record: ...]" lines, which the engine measures from filesystem snapshots, not in the assistant's own prose; where they disagree, the verified record wins. Give the exact file counts and never quote the "[Verified record: ...]" line itself.
3. Decisions made and why, plus constraints and preferences the user stated.
4. Files, functions, commands and values that matter (exact paths).
5. Open items — errors pending, what to do next.

Never greet, never address the user, never mention that this is a summary or that a chat is being continued. Reply with ONLY the note.`

/**
 * Text sent to the brief's prompt: from the last summary (inclusive, whole) up to
 * the end of the history. It reuses buildCompactionTranscript so that the previous summary
 * is never cut by the ceiling — the brief loses its meaning without it.
 */
export function buildContinuationTranscript(history: ChatMessage[]): string {
  const start = Math.max(0, findLastSummaryIndex(history))
  return buildCompactionTranscript(history.slice(start))
}

/**
 * Generates the continuity brief. Returns the plain text (without a header) or null
 * when there is nothing to transfer. Failure is silent for whoever calls — the
 * suggestion to continue in a new chat simply does not show up.
 */
export async function generateContinuationBrief(
  history: ChatMessage[],
  model: LanguageModel,
  providerOptions?: Record<string, Record<string, JSONValue>>,
): Promise<string | null> {
  const transcript = buildContinuationTranscript(history)
  if (!transcript.trim()) return null
  const { text } = await generateText({
    model,
    system: CONTINUATION_PROMPT,
    prompt: transcript,
    providerOptions,
  })
  return text.trim() || null
}
