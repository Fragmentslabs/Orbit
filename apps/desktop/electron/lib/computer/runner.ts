import { spawn } from 'node:child_process'
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
