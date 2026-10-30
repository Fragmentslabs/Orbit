import type { ChatMessage, TextPart } from '@shared/chat'

/** How many paths to cite before summarizing: the note is context, not a log. */
const WRITE_LIMIT = 12

/** How much of the interrupted text fits in the note. The end is what shows where it stopped. */
const TEXT_LIMIT = 240

/** One line, without "]" — the format ENGINE_MARKER_LINE recognizes. */
function flat(text: string): string {
  return text.replace(/[[\]\n\r]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Engine note for a REDONE turn ("retry").
 *
 * It goes in the request and never on screen: it is appended to the last user message
 * (see `withMemoryBlock` in chat-engine) and `stripEngineMarkers` guarantees that it does
 * not leak into the visible answer.
 *
 * Without it the model starts over as if it were the first time. The answer that failed
 * leaves the history, so it has no way of knowing there was already an attempt: it either
 * rewrites what is already on disk, or treats as done what was left
 * half-way. With the note it goes in knowing what failed, what may have been left
 * broken and that the right thing is to check before continuing.
 *
 * A single line and no "]" in the middle: that is the format
 * ENGINE_MARKER_LINE (todo-context.ts) recognizes and removes.
 */
export function retryContextNote(failed: ChatMessage): string {
  // The error text is provider diagnostics: it may have brackets, line
  // breaks and hundreds of characters. The note is one line, so only the beginning fits.
  const error = flat(failed.error ?? '').slice(0, 240)
  // ToolParts never go back to the model, so the text the previous attempt
  // got to write is the only thread of its narrative — and the end is where it stopped.
  const written = flat(
    failed.parts
      .filter((p): p is TextPart => p.type === 'text')
      .map((p) => p.text)
      .join(' '),
  )
  const tools = failed.parts.filter((p) => p.type === 'tool')
  const toolErrors = tools.filter((p) => p.state === 'error').length
  const writes = failed.snapshot?.authored ?? []

  const said = [
    'this is a RETRY of the same request from the user, not a new one',
    error
      ? `the previous attempt stopped with "${error}"`
      : 'the previous attempt was interrupted before it finished',
  ]
  if (tools.length > 0) {
    const calls = `${tools.length} tool call${tools.length === 1 ? '' : 's'}`
    said.push(toolErrors > 0 ? `after ${calls} (${toolErrors} of them ended in error)` : `after ${calls}`)
  }
  if (writes.length > 0) {
    // A bracket in a path (src/[id].tsx) would break the single line of the marker:
    // the whole note would stop matching ENGINE_MARKER_LINE and would leak into the
    // visible answer. The path keeps no brackets, and only here.
    const shown = writes
      .slice(0, WRITE_LIMIT)
      .map((rel) => rel.replace(/[[\]]/g, ''))
      .join(', ')
    const rest = writes.length > WRITE_LIMIT ? ` (+${writes.length - WRITE_LIMIT} more)` : ''
    said.push(
      `it had already written ${shown}${rest} — those files may be half-done, so read them before building on them`,
    )
  } else if (tools.length > 0) {
    said.push('whatever it changed on disk may be half-done, so check the real state before repeating those calls')
  } else {
    said.push('nothing had run when it failed')
  }
  if (written.length > 0) {
    const tail = written.slice(-TEXT_LIMIT)
    said.push(
      `its last text stopped at "…${tail}" — do not repeat that word for word, but stay consistent with it`,
    )
  }
  said.push(
    tools.length > 0 || writes.length > 0
      ? 'resume from where it stopped instead of starting over'
      : 'go straight to the task',
  )
  return `[SYSTEM: ${said.join('. ')}.]`
}
