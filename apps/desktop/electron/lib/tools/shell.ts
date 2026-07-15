import { tool } from 'ai'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { ToolContext } from './context'

const DEFAULT_TIMEOUT = 2 * 60 * 1000
const MAX_TIMEOUT = 10 * 60 * 1000
const MAX_OUTPUT = 30_000

function runShell(command: string, cwd: string, timeout: number, abort: AbortSignal) {
  return new Promise<{ output: string; exitCode: number | null }>((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd })
      : spawn(process.env.SHELL || '/bin/bash', ['-c', command], { cwd })

    let output = ''
    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8')
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const timer = setTimeout(() => child.kill(), timeout)
    const onAbort = () => child.kill()
    abort.addEventListener('abort', onAbort)

    child.on('error', (err) => {
      clearTimeout(timer)
      abort.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      abort.removeEventListener('abort', onAbort)
      const truncated = output.length >= MAX_OUTPUT ? '\n… (saída truncada)' : ''
      resolve({ output: output.slice(0, MAX_OUTPUT) + truncated, exitCode })
    })
  })
}

export function createBashTool(ctx: ToolContext) {
  return tool({
    description:
      'Executa um comando de shell na pasta de trabalho e retorna stdout/stderr. Use para builds, testes, git, etc.',
    inputSchema: z.object({
      command: z.string().describe('Comando a executar'),
      description: z.string().optional().describe('Descrição curta do que o comando faz'),
      timeout: z.number().optional().describe('Timeout em milissegundos (máx. 10 minutos)'),
    }),
    execute: async ({ command, timeout }) => {
      const ms = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
      const { output, exitCode } = await runShell(command, ctx.directory, ms, ctx.abort)
      const status = exitCode === 0 ? '' : `\n(exit code: ${exitCode})`
      return `${output || '(sem saída)'}${status}`
    },
  })
}
