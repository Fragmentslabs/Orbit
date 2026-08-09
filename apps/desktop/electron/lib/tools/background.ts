import { tool } from 'ai'
import { z } from 'zod'
import { spawnBackground, killProcess, listProcesses, getProcessOutput } from '../process-manager'
import type { ToolContext } from './context'

export function createBackgroundTools(ctx: ToolContext) {
  const bashBackground = tool({
    description:
      'Runs a command in BACKGROUND in the working folder and returns immediately. ' +
      'Use for dev servers (npm run dev), long builds, watchers, etc. ' +
      'The process keeps running between tool calls. ' +
      'Use bash_list to see active processes and bash_kill to kill one.',
    inputSchema: z.object({
      label: z.string().describe('Friendly name to identify the process (e.g.: "Dev Server")'),
      command: z.string().describe('Command to run in background'),
    }),
    execute: async ({ label, command }) => {
      const info = spawnBackground(label, command, ctx.directory, ctx.sessionId)
      return {
        pid: info.pid,
        label: info.label,
        status: info.status,
        message: `Processo "${label}" iniciado (PID ${info.pid}).`,
      }
    },
  })

  const bashList = tool({
    description:
      'Lists all background processes started by bash_background. ' +
      'Shows PID, label, status, and uptime.',
    inputSchema: z.object({}),
    execute: async () => {
      const procs = listProcesses(ctx.sessionId)
      if (procs.length === 0) return 'Nenhum processo em background neste chat.'
      return procs
        .map(
          (p) =>
            `• ${p.label} (PID ${p.pid}) — ${p.status}${p.status === 'running' ? `, ativo há ${formatUptime(p.startTime)}` : ''}${p.exitCode !== undefined ? `, exit code ${p.exitCode}` : ''}`,
        )
        .join('\n')
    },
  })

  const bashKill = tool({
    description: 'Kills a background process by PID.',
    inputSchema: z.object({
      pid: z.number().describe('PID of the process to kill'),
    }),
    execute: async ({ pid }) => {
      const ok = killProcess(pid, ctx.sessionId)
      if (ok) return `Processo PID ${pid} morto.`
      return `Processo PID ${pid} não encontrado nesta sessão.`
    },
  })

  const bashOutput = tool({
    description:
      'Returns the recent output (stdout/stderr) of a background process. ' +
      'Use to follow the progress of builds or commands that were promoted to the background.',
    inputSchema: z.object({
      pid: z.number().describe('PID of the background process'),
      tail: z
        .number()
        .optional()
        .describe('Max chars to return from the end of the buffer (default 2000, max 20000)'),
    }),
    execute: async ({ pid, tail }) => {
      const limit = Math.min(Math.max(tail ?? 2000, 100), 20_000)
      const out = getProcessOutput(pid, ctx.sessionId)
      const proc = listProcesses(ctx.sessionId).find((p) => p.pid === pid)
      if (!proc && out === '') return `Processo PID ${pid} não encontrado nesta sessão.`
      const header = `${proc?.label ?? `PID ${pid}`} — ${proc?.status ?? 'finalizado'}`
      const snippet = out.length > limit ? `…(últimos ${limit} chars)\n${out.slice(-limit)}` : out
      return `${header}\n${snippet || '(sem saída ainda)'}`
    },
  })

  return { bash_background: bashBackground, bash_list: bashList, bash_kill: bashKill, bash_output: bashOutput }
}

function formatUptime(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
