import { tool } from 'ai'
import { spawn, execSync } from 'node:child_process'
import { z } from 'zod'
import type { ToolContext } from './context'

const DEFAULT_TIMEOUT = 2 * 60 * 1000
const MAX_TIMEOUT = 10 * 60 * 1000
const MAX_OUTPUT = 30_000
const SIGKILL_GRACE = 200

function killTree(pid: number): void {
  const isWin = process.platform === 'win32'
  if (isWin) {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' })
    } catch {
      // process may have already exited
    }
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL') } catch {}
    }, SIGKILL_GRACE)
  } catch {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
}

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

    const pid = child.pid
    const kill = () => { if (pid != null) killTree(pid) }

    const timer = setTimeout(() => kill(), timeout)
    const onAbort = () => kill()
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
      'Runs a shell command in the working folder and returns stdout/stderr. Use for builds, tests, git, etc.',
    inputSchema: z.object({
      command: z.string().describe('Command to run'),
      description: z.string().optional().describe('Short description of what the command does'),
      timeout: z.number().optional().describe('Timeout in milliseconds (max 10 minutes)'),
    }),
    execute: async ({ command, timeout }) => {
      const ms = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
      const { output, exitCode } = await runShell(command, ctx.directory, ms, ctx.abort)
      const status = exitCode === 0 ? '' : `\n(exit code: ${exitCode})`
      return `${output || '(sem saída)'}${status}`
    },
  })
}
