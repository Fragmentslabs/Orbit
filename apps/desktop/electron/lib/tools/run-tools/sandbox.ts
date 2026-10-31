import vm from 'node:vm'
import { OUTPUT_HEAD, OUTPUT_TAIL, SYNC_LIMIT_MS } from './limits'

/**
 * The sandbox of `run_tools`: runs a script written by the model and gives
 * back ONLY what it printed or returned.
 *
 * It is `node:vm` on purpose. The script gets a bare JavaScript context — the
 * standard language built-ins, `console` and `tools`, nothing else: no
 * `require`, no `process`, no filesystem, no network, no timers. Everything it
 * can do with the world outside passes through `tools`, which is why the
 * capability of the script equals the capability of the turn (and the
 * permission gate still sees each call).
 *
 * That is hermetic, NOT a security boundary: a host function handed to the
 * context can be walked back to the host realm through its constructor. The same
 * model already runs shell commands in this mode, so nothing is being protected
 * from it here — what matters is that the script cannot reach the disk by a side
 * door while the turn is meant to be limited to the tools it has.
 */

/** File name the script is compiled with: it is what the stack trace shows. */
const FILE = 'run_tools.js'
/** Line 1 of the compiled source is the wrapper; the user's code starts at line 2. */
const WRAPPER_HEAD = '(async () => {'
const WRAPPER_TAIL = '})()'

export type ScriptStop = 'timeout' | 'aborted' | null

export interface ScriptRun {
  /** The value the script returned (`return x`), if any. Serialized by the caller. */
  returned: unknown
  /** Everything written to console.*, head+tail capped. */
  output: string
  /** How many console lines were written (it survives the cap). */
  printed: number
  /** Runtime error, already formatted for the model (stack included). */
  error: string | null
  stopped: ScriptStop
  ms: number
}

export interface ScriptOptions {
  code: string
  /** Tool names the script may call. */
  names: readonly string[]
  /** Runs one tool by name; throw to fail the call inside the script. */
  bridge: (name: string, input: unknown) => Promise<unknown>
  /** Wall-clock ceiling of the whole run. */
  timeoutMs: number
  /** Ceiling for the synchronous slice (default: SYNC_LIMIT_MS, never above `timeoutMs`). */
  syncLimitMs?: number
  signal?: AbortSignal
}

/**
 * Same head/tail idea as the bash collector (`../shell`), kept local so the
 * sandbox — and its tests — do not drag the process manager along.
 */
function createCapture(headChars = OUTPUT_HEAD, tailChars = OUTPUT_TAIL) {
  let head = ''
  let tail = ''
  let total = 0
  let lines = 0
  return {
    append(text: string) {
      if (!text) return
      lines += 1
      total += text.length
      const room = Math.max(0, headChars - head.length)
      head += text.slice(0, room)
      const rest = text.slice(room)
      if (rest) tail = (tail + rest).slice(-tailChars)
    },
    count: () => lines,
    text() {
      const omitted = total - head.length - tail.length
      const body = omitted > 0 ? `${head}\n… (${omitted} characters omitted from the middle of the output) …\n${tail}` : head + tail
      return body.trimEnd()
    },
  }
}

/** A value as the script wrote it — works for objects of the sandbox's own realm. */
function display(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  if (typeof value === 'symbol') return value.toString()
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return json
  } catch {
    // circular: what is left is the generic form
  }
  return String(value)
}

/** Line numbers of the compiled source shifted back to the user's own script. */
function shiftLines(text: string): string {
  return text.replace(new RegExp(`${FILE}:(\\d+)`, 'g'), (_, line: string) => `${FILE}:${Math.max(1, Number(line) - 1)}`)
}

/** Errors cross the realm boundary, so `instanceof Error` is not reliable. */
function asError(err: unknown): { name: string; message: string; stack: string } | null {
  if (!err || typeof err !== 'object') return null
  const value = err as { name?: unknown; message?: unknown; stack?: unknown }
  if (typeof value.message !== 'string') return null
  return {
    name: typeof value.name === 'string' ? value.name : 'Error',
    message: value.message,
    stack: typeof value.stack === 'string' ? value.stack : '',
  }
}

/** The error as the model must read it: message plus the frames of ITS OWN lines. */
export function formatScriptError(err: unknown): string {
  const error = asError(err)
  if (!error) return `Script stopped with a thrown value: ${display(err)}`
  const text = shiftLines(error.name === 'Error' ? error.message : `${error.name}: ${error.message}`)
  const frames = error.stack
    .split('\n')
    .filter((line) => line.includes(FILE) && line.trim().startsWith('at '))
    .slice(0, 5)
  if (frames.length === 0) return text
  return `${text}\n${frames.map((frame) => `    ${shiftLines(frame.trim())}`).join('\n')}`
}

export async function runScript(options: ScriptOptions): Promise<ScriptRun> {
  const started = Date.now()
  const capture = createCapture()
  // After the run ends (by success, timeout or abort) late tool calls are a bug in
  // the script, not a request: they fail instead of touching the project.
  let dead = false

  const tools: Record<string, unknown> = {}
  for (const name of options.names) {
    tools[name] = async (input?: unknown) => {
      if (dead) throw new Error('the script already ended — a tool call after a timeout or an abort does not run')
      return options.bridge(name, input ?? {})
    }
  }
  Object.defineProperty(tools, 'names', { value: Object.freeze([...options.names]), enumerable: true })

  const write = (...args: unknown[]) => capture.append(`${args.map(display).join(' ')}\n`)
  const sandboxConsole = { log: write, info: write, debug: write, warn: write, error: write, table: write, dir: write }

  const context = vm.createContext({ tools, console: sandboxConsole })
  const source = `${WRAPPER_HEAD}\n${options.code}\n${WRAPPER_TAIL}`
  const syncLimit = Math.max(1000, Math.min(options.syncLimitMs ?? SYNC_LIMIT_MS, options.timeoutMs))

  return new Promise<ScriptRun>((resolve) => {
    let done = false
    const finish = (patch: { returned?: unknown; error?: string; stopped?: ScriptStop } = {}) => {
      if (done) return
      done = true
      dead = true
      clearTimeout(wallTimer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        returned: patch.returned,
        output: capture.text(),
        printed: capture.count(),
        error: patch.error ?? null,
        stopped: patch.stopped ?? null,
        ms: Date.now() - started,
      })
    }
    const onAbort = () => finish({ stopped: 'aborted' })
    const wallTimer = setTimeout(() => finish({ stopped: 'timeout' }), options.timeoutMs)

    if (options.signal?.aborted) {
      finish({ stopped: 'aborted' })
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    let running: Promise<unknown>
    try {
      running = new vm.Script(source, { filename: FILE }).runInContext(context, { timeout: syncLimit }) as Promise<unknown>
    } catch (err) {
      // A synchronous throw, or the sync limit hit (the watchdog interrupts the run).
      const timedOut = (err as { code?: unknown })?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
      finish(timedOut ? { stopped: 'timeout' } : { error: formatScriptError(err) })
      return
    }
    Promise.resolve(running).then(
      (returned) => finish({ returned }),
      (err) => finish({ error: formatScriptError(err) }),
    )
  })
}
