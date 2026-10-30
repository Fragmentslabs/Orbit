import type { ArtifactPart, ChatMessage, ToolPart } from '@shared/chat'

/**
 * toModelMessages/textOf (compaction) only resend TextParts — ToolParts
 * (including every todowrite call) never come back to the model in future
 * turns. That erases the TODO state between turns: on saying "continue", the
 * model no longer sees its own list and often recreates one from scratch.
 * This module extracts that state as text so it survives the cut.
 *
 * HTML artifacts suffer from the same cut for the same reason: the `artifactId`
 * comes back in the tool's RESULT, which only exists inside the turn that called it.
 * Without the note, "change the chart's color" in the next turn reaches a model
 * that no longer knows the id of what it itself drew — and it creates a second
 * artifact instead of updating the first.
 */

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

function todoItems(message: ChatMessage): TodoItem[] | undefined {
  const todo = [...message.parts]
    .reverse()
    .find((p): p is ToolPart => p.type === 'tool' && p.tool === 'todowrite' && p.state === 'done')
  return todo?.input?.items as TodoItem[] | undefined
}

function formatTodoState(items: TodoItem[]): string {
  const mark = { completed: 'x', in_progress: '~', pending: ' ' } as const
  const lines = items.map((i) => `- [${mark[i.status] ?? ' '}] ${i.content}`)
  return `[TODO for this response]\n${lines.join('\n')}`
}

/**
 * Artifacts that the answer materialized. One part per
 * create_artifact/update_artifact call — the same id may show up twice if the
 * agent created and already fixed it in the same turn, so the list is deduplicated by
 * id, keeping the LAST revision seen.
 */
function artifactRefs(message: ChatMessage): ArtifactPart[] {
  const byId = new Map<string, ArtifactPart>()
  for (const part of message.parts) {
    if (part.type === 'artifact') byId.set(part.artifactId, part)
  }
  return [...byId.values()]
}

/**
 * A SINGLE line, prefixed with [SYSTEM: and with no internal "]": it is what
 * makes stripEngineMarkers able to remove it if the model starts imitating it
 * in the visible text (ENGINE_MARKER_LINE matches the whole line, without "]" in the middle).
 */
function formatArtifacts(refs: ArtifactPart[]): string | null {
  if (refs.length === 0) return null
  const list = refs
    .map((r) => `${r.artifactId} (${r.title.replace(/[[\]]/g, '')})`)
    .join('; ')
  return `[SYSTEM: HTML artifacts rendered in this response — ${list}. If the user asks for a CHANGE to one of them, call update_artifact with that exact id and the full new HTML; do NOT call create_artifact again, which would leave a duplicate in the conversation and in the gallery.]`
}

/** How many files to cite in the record before summarizing (context is expensive). */
const LEDGER_FILE_LIMIT = 12

/**
 * Verified record of the turn: what the engine MEASURED comparing the filesystem
 * snapshots, not what the agent said it did.
 *
 * It is the piece that closes the hole described at the top of this file: since ToolParts
 * do not come back to the model, a long chat's history keeps only the agent's
 * narrative about its own work. A sentence like "I implemented X" becomes
 * indistinguishable from having actually implemented it, and in the following turns the model
 * treats it as established fact ("since I already implemented X, only Y is left").
 * Pasting the measured verdict next to the narrative, the false claim starts to
 * arrive always accompanied by the rebuttal.
 */
function formatChangeLedger(message: ChatMessage): string | null {
  const verified = message.snapshot?.verified
  if (!verified) return null
  if (verified === 'unknown') {
    return '[Verified record: file tracking failed for this turn — no claim can be made about what was written.]'
  }
  if (verified === 'unchanged') {
    return '[Verified record: NO file was modified in this turn (filesystem snapshot before/after identical).]'
  }
  const files = message.snapshot?.files ?? []
  if (files.length === 0) return '[Verified record: files were modified in this turn.]'
  const shown = files.slice(0, LEDGER_FILE_LIMIT).join(', ')
  const rest = files.length > LEDGER_FILE_LIMIT ? ` (+${files.length - LEDGER_FILE_LIMIT} more)` : ''
  return `[Verified record: ${files.length} file(s) modified in this turn — ${shown}${rest}]`
}

/**
 * Internal markers that the engine attaches to the context and that can NEVER
 * show up in the visible answer: verified record and [SYSTEM: ...] warnings.
 * They only match when they occupy the whole line — a mention in prose ("the line
 * [Verified record: ...] serves to...") stays intact.
 */
const ENGINE_MARKER_LINE = /^\s*\[(?:Verified record|SYSTEM):[^\]]*\]\s*$/
const CODE_FENCE = /^\s*(?:```|~~~)/

/**
 * Safety net against the markers leaking into the visible answer.
 *
 * The model receives these lines in the context and, in a long history, starts
 * treating them as part of its own answer format — reproducing
 * "[Verified record: ...]" at the end of the text the user reads. The prompt already
 * forbids copying them (VERIFIED_RECORD_INSTRUCTION) and engineAnnotations no longer
 * pastes them inside the assistant's turn; this is the final guarantee.
 *
 * Lines inside a code block are preserved: this repository
 * discusses the markers themselves in the code and in the docs.
 */
export function stripEngineMarkers(text: string): string {
  if (!text.includes('[Verified record:') && !text.includes('[SYSTEM:')) return text
  let inFence = false
  const kept = text.split('\n').filter((line) => {
    if (CODE_FENCE.test(line)) {
      inFence = !inFence
      return true
    }
    return inFence || !ENGINE_MARKER_LINE.test(line)
  })
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The engine's notes about a turn: TODO state, verified record of
 * files and truncation/reminder warnings. It is bookkeeping ABOUT the message,
 * not its content — whoever sends it to the model decides where to fit it (see
 * toModelMessages: it goes in the following user message, never inside the
 * assistant's text).
 */
export function engineAnnotations(message: ChatMessage): string {
  const parts: string[] = []

  const items = todoItems(message)
  if (items?.length) parts.push(formatTodoState(items))

  const ledger = formatChangeLedger(message)
  if (ledger) parts.push(ledger)

  const artifacts = formatArtifacts(artifactRefs(message))
  if (artifacts) parts.push(artifacts)

  // An item marked "completed" is the model's assertion, not a measurement. In a turn in
  // which nothing was written, the checklist becomes the most convincing "proof" in
  // the history — the note keeps it from being read as such.
  if (message.snapshot?.verified === 'unchanged' && items?.some((i) => i.status === 'completed')) {
    parts.push(
      '[SYSTEM: the TODO items above were marked "completed" by you, but no file changed in this turn. Marking an item done is a claim, not evidence — if the work still has to be written to disk, treat those items as pending.]',
    )
  }

  if (message.truncated) {
    parts.push(
      '[SYSTEM: this response was interrupted by hitting the step/tool limit before finishing. If the TODO above has pending or in_progress items, CONTINUE from them — do not recreate the list from scratch.]',
    )
  }

  // Persistent reminder of an unclosed TODO (item in in_progress at the end
  // of the turn): re-emitted on every following turn until the model settles the
  // state — it demands the closing even when the user says "continue".
  if (message.todoReminder) {
    parts.push(
      '[SYSTEM: the previous reply ended with TODO items still marked as "in_progress" — the checklist was never finalized. If those tasks are actually done, send the todo list again marking them as "completed" (the card in the UI still shows a spinner). If they are genuinely still in progress, say so explicitly before continuing.]',
    )
  }

  return parts.filter((p) => p.trim()).join('\n\n')
}

/** Text of a message to summarize in compaction: narration + the engine's notes
 * about the turn (TODO, verified record, warnings). */
export function messageContextText(message: ChatMessage, text: string): string {
  return [text, engineAnnotations(message)].filter((p) => p.trim()).join('\n\n')
}
