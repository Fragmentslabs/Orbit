import type { ToolSet } from 'ai'
import { MAX_TOOL_CALLS } from './limits'

/**
 * The bridge: how a tool call written INSIDE the script reaches the real tool.
 *
 * Two rules make it safe to have a script calling tools:
 *
 * 1. What the script may call is exactly what the turn has (minus `run_tools`
 *    itself — no recursion). The script does not gain a capability; it gains
 *    fewer round trips.
 * 2. Every call goes through the SAME permission gate the model's own calls go
 *    through. A sequence of tool calls inside a script is exactly where an agent
 *    could slip an action past the user, so the gate is not optional.
 *
 * A call that fails or is denied throws inside the script, which is what lets the
 * model handle it with try/catch instead of losing the whole run.
 */

export type ApprovalResult = 'approved' | { type: 'denied'; reason?: string }
/** The same shape as the SDK's `toolApproval` — the function the model's own calls already go through. */
export type ToolApprovalGate = (call: {
  toolCall: { toolCallId: string; toolName: string; input: unknown }
}) => Promise<ApprovalResult>

export interface BridgeCall {
  name: string
  ok: boolean
  error?: string
  /** Exit code the tool reported (`bash` writes it in the text), when it has one. */
  exit?: number
  /** First line the tool said — the only glimpse of a command that exited non-zero. */
  head?: string
}

/**
 * `bash` closes its text with `(exit code: N)` when the command did not succeed. A
 * script that parses the output and ignores that line turns a broken command into a
 * confident wrong answer: a `find` on a folder that does not exist came back as
 * "0 files" instead of "no such file", and the model had to probe three more times.
 */
const EXIT_CODE = /\(exit code: (-?\d+)\)\s*$/

function exitCodeOf(text: string): number | undefined {
  const found = EXIT_CODE.exec(text)
  return found ? Number(found[1]) : undefined
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? ''
  return line.length > 140 ? `${line.slice(0, 140)}…` : line.trim()
}

export interface BridgeOptions {
  /** The turn's ToolSet, read on every run — it is still being assembled when the tool is created. */
  tools: () => ToolSet
  /** The gate of the turn. Without one, nothing runs. */
  approve?: ToolApprovalGate
  signal?: AbortSignal
  /** Prefix of the synthetic call ids (they show up in the permission request). */
  idPrefix: string
}

export interface ToolBridge {
  /** Names the script may call. */
  names: string[]
  call: (name: string, input: unknown) => Promise<unknown>
  /** Every call of the run, in order — the summary the model reads. */
  calls: BridgeCall[]
}

interface ExecutableTool {
  inputSchema?: unknown
  execute?: (input: unknown, options: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }) => unknown
}

/** How many names the "does not exist" error lists — enough to choose, not a catalog. */
const LISTED_NAMES = 60

/**
 * The result as the script receives it: the same text the model would have
 * received. Keeping the format identical means the instructions about `read`,
 * `grep` and the rest stay true inside the script.
 */
export function toText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === null || output === undefined) return ''
  if (typeof output === 'object') {
    const message = (output as { message?: unknown }).message
    if (typeof message === 'string') return message
    try {
      return JSON.stringify(output)
    } catch {
      return String(output)
    }
  }
  return String(output)
}

function listNames(names: readonly string[]): string {
  if (names.length <= LISTED_NAMES) return names.join(', ')
  return `${names.slice(0, LISTED_NAMES).join(', ')}… (${names.length} in total: tools.names lists them)`
}

/**
 * Validates the input against the tool's own schema before calling it. The tool
 * bodies assume well-typed arguments, and "expected string, received object" is
 * a far better error for the model than the undefined-access crash it would
 * otherwise get three lines deep.
 */
function validate(name: string, schema: unknown, input: unknown): unknown {
  const parse = (schema as { safeParse?: (value: unknown) => { success: boolean; error?: unknown } } | undefined)?.safeParse
  if (typeof parse !== 'function') return input
  const result = parse.call(schema, input)
  if (result.success) return (result as { data?: unknown }).data ?? input
  const issues = (result.error as { issues?: { path?: (string | number)[]; message?: string }[] } | undefined)?.issues ?? []
  const detail = issues
    .slice(0, 5)
    .map((issue) => `${issue.path?.length ? issue.path.join('.') : '(root)'}: ${issue.message ?? 'invalid'}`)
    .join('; ')
  throw new Error(`${name}: invalid input — ${detail || 'does not match the schema'}`)
}

export function createToolBridge(options: BridgeOptions): ToolBridge {
  const calls: BridgeCall[] = []
  const available = (): ToolSet => options.tools() ?? ({} as ToolSet)
  const names = Object.keys(available()).filter(
    (name) => name !== 'run_tools' && typeof (available()[name] as ExecutableTool | undefined)?.execute === 'function',
  )
  let count = 0

  const call = async (name: string, input: unknown): Promise<unknown> => {
    count += 1
    if (count > MAX_TOOL_CALLS) {
      throw new Error(`stopped: more than ${MAX_TOOL_CALLS} tool calls in one script — split the work in parts`)
    }
    if (options.signal?.aborted) throw new Error('stopped by the user')
    if (!names.includes(name)) {
      throw new Error(`no tool called "${name}" in this turn. Available: ${listNames(names)}`)
    }

    const tool = available()[name] as ExecutableTool | undefined
    if (!tool?.execute) throw new Error(`"${name}" cannot be called from a script`)

    const args = validate(name, tool.inputSchema, input)
    const toolCallId = `${options.idPrefix}-${count}`

    if (!options.approve) {
      calls.push({ name, ok: false, error: 'no permission gate' })
      throw new Error(`${name} was not run: there is no permission gate in this execution`)
    }
    const decision = await options.approve({ toolCall: { toolCallId, toolName: name, input: args } })
    if (decision !== 'approved') {
      const reason = decision.type === 'denied' ? (decision.reason ?? 'denied by the user') : 'denied'
      calls.push({ name, ok: false, error: reason })
      throw new Error(`${name} was NOT run — ${reason}`)
    }

    try {
      const output = await tool.execute(args, { toolCallId, messages: [], abortSignal: options.signal })
      const text = toText(output)
      const exit = exitCodeOf(text)
      calls.push(exit === undefined ? { name, ok: true } : { name, ok: true, exit, head: firstLine(text) })
      return text
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      calls.push({ name, ok: false, error: message })
      throw new Error(`${name} failed: ${message}`)
    }
  }

  return { names, call, calls }
}
