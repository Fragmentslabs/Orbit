import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { ComputerError } from './types'

/**
 * Runs a bridge operation in a child process and returns its JSON. The bridge can
 * never hang the turn: timeout per operation, kill on abort and any process failure
 * becomes a ComputerError with an actionable message — never a raw child_process
 * exception.
 */

export interface BridgeSpawn {
  (command: string, args: string[]): {
    stdout: NodeJS.ReadableStream
    stderr: NodeJS.ReadableStream
    on(event: 'close', listener: (code: number | null) => void): unknown
    on(event: 'error', listener: (err: Error) => void): unknown
    kill(signal?: NodeJS.Signals): unknown
  }
}

export interface RunOptions {
  timeoutMs: number
  signal?: AbortSignal
}

/** Maximum accepted output (a big tree with long texts fits comfortably). */
const MAX_OUTPUT = 32 * 1024 * 1024

export function createBridgeRunner(command: string, baseArgs: () => Promise<string[]>, spawnFn: BridgeSpawn = spawn) {
  return async function run<T>(op: string, args: unknown, options: RunOptions): Promise<T> {
    if (options.signal?.aborted) throw new ComputerError('aborted', 'Computer use was stopped.')
    const argv = [...(await baseArgs()), JSON.stringify({ op, args })]
    return new Promise<T>((resolve, reject) => {
      const child = spawnFn(command, argv)
      let out = ''
      let err = ''
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        fn()
      }
      // The outcome is recorded BEFORE the kill: the `close` the kill causes cannot
      // swap "timeout"/"stopped" for "exited without answering".
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new ComputerError(
              'timeout',
              `The ${op} operation took more than ${Math.round(options.timeoutMs / 1000)}s and was stopped. The target app may be busy — try again, or observe with a smaller max_nodes.`,
            ),
          ),
        )
        child.kill('SIGKILL')
      }, options.timeoutMs)
      const onAbort = () => {
        finish(() => reject(new ComputerError('aborted', 'Computer use was stopped.')))
        child.kill('SIGKILL')
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
        if (out.length > MAX_OUTPUT) {
          finish(() => reject(new ComputerError('bridgeError', 'The bridge returned too much data.')))
          child.kill('SIGKILL')
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8')
      })
      child.on('error', (e) => finish(() => reject(new ComputerError('bridgeError', `Could not start the bridge: ${e.message}`))))
      child.on('close', () =>
        finish(() => {
          const text = out.trim()
          if (!text) {
            reject(new ComputerError('bridgeError', `The bridge exited without an answer${err ? `: ${err.trim().slice(0, 300)}` : '.'}`))
            return
          }
          let parsed: { ok: boolean; result?: T; error?: { code: string; message: string } }
          try {
            parsed = JSON.parse(text)
          } catch {
            reject(new ComputerError('bridgeError', `Unreadable bridge output: ${text.slice(0, 200)}`))
            return
          }
          if (parsed.ok) resolve(parsed.result as T)
          else reject(new ComputerError(parsed.error?.code ?? 'bridgeError', parsed.error?.message ?? 'Bridge error.'))
        }),
      )
    })
  }
}

/**
 * Persistent host (Windows): ONE process that reads one JSON request per line on
 * stdin and answers one line per request on stdout, correlated by `id`. The cost of
 * starting PowerShell and compiling the C# (~1–2 s) is paid once, not on every
 * operation. The signature of `run` is the same as `createBridgeRunner`'s: the driver
 * does not know which of the two it is using.
 *
 * The host is sequential (the requests wait in stdin's queue). A timeout or abort of
 * one operation kills the host — there is no way to interrupt a stuck UIA call — and
 * the other pending requests fail with "restarted"; the next use starts a new host.
 */

export interface PersistentChild {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  on(event: 'close', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals): unknown
}

export interface PersistentSpawn {
  (command: string, args: string[]): PersistentChild
}

export interface PersistentOptions {
  /** Extra deadline for the first request of each host (start + compilation) */
  startupGraceMs?: number
}

export interface PersistentRunner {
  <T>(op: string, args: unknown, options: RunOptions): Promise<T>
  /** Shuts the host down (app exit); the next use starts another one */
  dispose(): void
  /** Is there a live host right now? (tests and diagnostics) */
  alive(): boolean
}

interface Pending {
  op: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  cleanup: () => void
}

interface Host {
  child: PersistentChild
  pending: Map<number, Pending>
  /** It has not answered anything yet: the first request pays for the start */
  fresh: boolean
  stderr: string
  dead: boolean
}

const STDERR_TAIL = 2000

export function createPersistentRunner(
  command: string,
  baseArgs: () => Promise<string[]>,
  spawnFn: PersistentSpawn = spawn as unknown as PersistentSpawn,
  options: PersistentOptions = {},
): PersistentRunner {
  let host: Host | null = null
  let starting: Promise<Host> | null = null
  let seq = 0

  // Kills the host and fails whoever is still waiting. `host = null` comes before the
  // kill: its `close` cannot touch a new host, and the next use already starts another.
  function kill(target: Host, reason: ComputerError): void {
    if (target.dead) return
    target.dead = true
    if (host === target) host = null
    for (const p of target.pending.values()) {
      p.cleanup()
      p.reject(reason)
    }
    target.pending.clear()
    try {
      target.child.kill('SIGKILL')
    } catch {
      // already dead
    }
  }

  async function ensure(): Promise<Host> {
    if (host && !host.dead) return host
    starting ??= (async () => {
      const argv = await baseArgs()
      const child = spawnFn(command, argv)
      const h: Host = { child, pending: new Map(), fresh: true, stderr: '', dead: false }
      // StringDecoder: a UTF-8 character can arrive split between two chunks.
      const decoder = new StringDecoder('utf8')
      let buffer = ''
      child.stdout.on('data', (chunk: Buffer | string) => {
        buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (line) answer(h, line)
          nl = buffer.indexOf('\n')
        }
        if (buffer.length > MAX_OUTPUT) kill(h, new ComputerError('bridgeError', 'The Windows host returned too much data.'))
      })
      child.stderr.on('data', (chunk: Buffer | string) => {
        h.stderr = (h.stderr + chunk.toString()).slice(-STDERR_TAIL)
      })
      child.stdin.on('error', () => undefined)
      child.on('error', (e) => kill(h, new ComputerError('bridgeError', `Could not start the Windows host: ${e.message}`)))
      child.on('close', (code) => {
        const tail = h.stderr.trim().slice(-300)
        kill(h, new ComputerError('bridgeError', `The Windows host exited${code !== null ? ` (code ${code})` : ''} without an answer${tail ? `: ${tail}` : '.'}`))
      })
      host = h
      return h
    })().finally(() => {
      starting = null
    })
    return starting
  }

  function answer(h: Host, line: string): void {
    let parsed: { id?: number; ok?: boolean; result?: unknown; error?: { code?: string; message?: string } }
    try {
      parsed = JSON.parse(line)
    } catch {
      // A line that is not from the protocol (PowerShell warning): keep it as stderr.
      h.stderr = (h.stderr + line + '\n').slice(-STDERR_TAIL)
      return
    }
    h.fresh = false
    const p = typeof parsed.id === 'number' ? h.pending.get(parsed.id) : undefined
    if (!p || typeof parsed.id !== 'number') return
    h.pending.delete(parsed.id)
    p.cleanup()
    if (parsed.ok) p.resolve(parsed.result)
    else p.reject(new ComputerError(parsed.error?.code ?? 'bridgeError', parsed.error?.message ?? 'Windows host error.'))
  }

  const run = (async <T>(op: string, args: unknown, opts: RunOptions): Promise<T> => {
    if (opts.signal?.aborted) throw new ComputerError('aborted', 'Computer use was stopped.')
    const h = await ensure()
    if (opts.signal?.aborted) throw new ComputerError('aborted', 'Computer use was stopped.')
    const id = ++seq
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs + (h.fresh ? (options.startupGraceMs ?? 0) : 0)
      const restarted = new ComputerError('bridgeError', `The Windows host was restarted while ${op} waited (another operation timed out or was stopped) — try again.`)
      // The outcome of this request is recorded BEFORE the kill: the `close` the
      // kill causes cannot swap "timeout"/"stopped" for "exited without answering".
      const settle = (err: ComputerError) => {
        const p = h.pending.get(id)
        if (!p) return
        h.pending.delete(id)
        p.cleanup()
        reject(err)
        kill(h, restarted)
      }
      const timer = setTimeout(
        () =>
          settle(
            new ComputerError(
              'timeout',
              `The ${op} operation took more than ${Math.round(timeoutMs / 1000)}s and was stopped. The target app may be busy — try again, or observe with a smaller max_nodes.`,
            ),
          ),
        timeoutMs,
      )
      const onAbort = () => settle(new ComputerError('aborted', 'Computer use was stopped.'))
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      h.pending.set(id, {
        op,
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort)
        },
      })
      try {
        h.child.stdin.write(`${JSON.stringify({ id, op, args })}\n`)
      } catch (e) {
        kill(h, new ComputerError('bridgeError', `Could not talk to the Windows host: ${(e as Error).message}`))
      }
    })
  }) as PersistentRunner
  run.dispose = () => {
    if (host) kill(host, new ComputerError('aborted', 'The Windows host was closed.'))
  }
  run.alive = () => Boolean(host && !host.dead)
  return run
}
