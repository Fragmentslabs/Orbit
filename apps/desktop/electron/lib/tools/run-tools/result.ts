import { toText, type BridgeCall } from './bridge'
import type { ScriptRun } from './sandbox'
import { MAX_RETURN_CHARS, SHALLOW_RUN_CALLS } from './limits'

/**
 * What the model reads after a run.
 *
 * The script's own output is the answer; everything added here exists because the
 * model did NOT see the run: how long it took, which tools ran, which failed — and,
 * when nothing came out, that it forgot to send anything back. Without the failure
 * summary a script that swallowed three errors would look like a script that found
 * nothing.
 */

/** "glob×1, read×8" — in the order they were first called. */
function countCalls(calls: readonly BridgeCall[]): string {
  const order: string[] = []
  const totals = new Map<string, number>()
  for (const call of calls) {
    if (!totals.has(call.name)) order.push(call.name)
    totals.set(call.name, (totals.get(call.name) ?? 0) + 1)
  }
  return order.map((name) => `${name}×${totals.get(name)}`).join(', ')
}

function clip(text: string): string {
  if (text.length <= MAX_RETURN_CHARS) return text
  return `${text.slice(0, MAX_RETURN_CHARS)}\n… (${text.length - MAX_RETURN_CHARS} more characters not shown — return only what matters)`
}

/** The line with what it cost and what ran. */
export function statLine(run: ScriptRun, calls: readonly BridgeCall[]): string {
  const parts = [`${(run.ms / 1000).toFixed(run.ms < 1000 ? 2 : 1)}s`]
  if (calls.length > 0) parts.push(`${calls.length} tool call${calls.length === 1 ? '' : 's'}: ${countCalls(calls)}`)
  if (run.printed > 0) parts.push(`${run.printed} console line${run.printed === 1 ? '' : 's'}`)
  const failures = calls.filter((call) => !call.ok)
  if (failures.length > 0) {
    const first = failures[0].error ?? 'error'
    parts.push(`${failures.length} failed (${first.length > 160 ? `${first.slice(0, 160)}…` : first})`)
  }
  // A command that exits non-zero without throwing leaves no trace of its own: the
  // script reads its text, decides, and returns a summary. This line is the only
  // place the model learns that a step in the middle did not work.
  const exited = calls.filter((call) => call.ok && call.exit !== undefined && call.exit !== 0)
  if (exited.length > 0) {
    const first = exited[0]
    parts.push(`${exited.length} exited non-zero (${first.name} → ${first.exit}${first.head ? `: ${first.head}` : ''})`)
  }
  return `[${parts.join(' · ')}]`
}

/**
 * Feedback on the step the model just took. A run with one or two calls is a tool
 * call with a round trip on top. The description says this once, at the start, and
 * does not change what the model does next; this line arrives while it decides.
 */
function shallowNote(calls: readonly BridgeCall[]): string {
  if (calls.length === 0 || calls.length > SHALLOW_RUN_CALLS) return ''
  return `Only ${calls.length} tool ${calls.length === 1 ? 'call' : 'calls'} in this run — the saving comes from ONE script doing the whole job. Sweep everything, then return just the conclusion.`
}

export function formatRun(run: ScriptRun, calls: readonly BridgeCall[], timeoutMs: number): string {
  const stats = statLine(run, calls)
  const partial = run.output ? `\n\nOutput so far:\n${run.output}` : ''

  if (run.stopped === 'timeout') {
    return `(stopped after ${Math.round(timeoutMs / 1000)}s — the script did not finish. Narrow the work, or split it in parts.)${partial}\n\n${stats}`
  }
  if (run.stopped === 'aborted') return `(stopped by the user)${partial}\n\n${stats}`
  if (run.error) return `${run.error}${partial}\n\n${stats}`

  const returned = clip(toText(run.returned))
  // Both are deliberate: what it returned is the answer, what it printed is what it
  // chose to log. Showing only one of them hides half of what the script produced.
  const body =
    returned && run.output
      ? `${returned}\n\nPrinted:\n${run.output}`
      : returned ||
        run.output ||
        '(the script printed nothing and returned nothing — use console.log or `return` to send something back)'
  const note = shallowNote(calls)
  return `${body}\n\n${stats}${note ? `\n${note}` : ''}`
}
