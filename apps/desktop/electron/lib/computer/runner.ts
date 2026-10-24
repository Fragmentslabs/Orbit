import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { ComputerError } from './types'

/**
 * Executa uma operação da bridge num processo filho e devolve o JSON dela.
 * A bridge nunca pode travar o turno: timeout por operação, kill no abort e
 * qualquer falha do processo vira ComputerError com mensagem acionável —
 * nunca uma exceção crua do child_process.
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

/** Saída máxima aceita (árvore grande com textos longos cabe folgada). */
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
      // O desfecho é registrado ANTES do kill: o `close` que o kill provoca não
      // pode trocar "timeout"/"parado" por "saiu sem resposta".
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
 * Host persistente (Windows): UM processo que lê um pedido JSON por linha no
 * stdin e responde uma linha por pedido no stdout, correlacionada por `id`. O
 * custo de subir o PowerShell e compilar o C# (~1–2 s) é pago uma vez, não a
 * cada operação. A assinatura de `run` é a mesma do `createBridgeRunner`: o
 * driver não sabe qual dos dois está usando.
 *
 * O host é sequencial (os pedidos esperam na fila do stdin). Timeout ou abort
 * de uma operação matam o host — não há como interromper uma chamada da UIA
 * presa — e os outros pedidos pendentes falham com "reiniciado"; o próximo uso
 * sobe um host novo.
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
  /** Prazo extra do primeiro pedido de cada host (partida + compilação) */
  startupGraceMs?: number
}

export interface PersistentRunner {
  <T>(op: string, args: unknown, options: RunOptions): Promise<T>
  /** Encerra o host (fim do app); o próximo uso sobe outro */
  dispose(): void
  /** Há um host vivo agora? (testes e diagnóstico) */
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
  /** Ainda não respondeu nada: o primeiro pedido paga a partida */
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

  // Mata o host e falha o que ainda espera. `host = null` vem antes do kill: o
  // `close` dele não pode mexer num host novo, e o próximo uso já sobe outro.
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
      // já morreu
    }
  }

  async function ensure(): Promise<Host> {
    if (host && !host.dead) return host
    starting ??= (async () => {
      const argv = await baseArgs()
      const child = spawnFn(command, argv)
      const h: Host = { child, pending: new Map(), fresh: true, stderr: '', dead: false }
      // StringDecoder: um caractere UTF-8 pode chegar partido entre dois chunks.
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
      // Linha que não é do protocolo (aviso do PowerShell): guarda como stderr.
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
      // O desfecho deste pedido é registrado ANTES do kill: o `close` que o
      // kill provoca não pode trocar "timeout"/"parado" por "saiu sem resposta".
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
