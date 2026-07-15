import { tool } from 'ai'
import { z } from 'zod'
import { spawnBackground, killProcess, listProcesses } from '../process-manager'
import type { ToolContext } from './context'

export function createBackgroundTools(ctx: ToolContext) {
  const bashBackground = tool({
    description:
      'Executa um comando em BACKGROUND na pasta de trabalho e retorna imediatamente. ' +
      'Use para servidores de desenvolvimento (npm run dev), builds longos, watchers, etc. ' +
      'O processo continua rodando entre chamadas de ferramenta. ' +
      'Use bash_list para ver processos ativos e bash_kill para matar.',
    inputSchema: z.object({
      label: z.string().describe('Nome amigável para identificar o processo (ex: "Dev Server")'),
      command: z.string().describe('Comando a executar em background'),
    }),
    execute: async ({ label, command }) => {
      const info = spawnBackground(label, command, ctx.directory)
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
      'Lista todos os processos em background iniciados pelo bash_background. ' +
      'Mostra PID, label, status e tempo de atividade.',
    inputSchema: z.object({}),
    execute: async () => {
      const procs = listProcesses()
      if (procs.length === 0) return 'Nenhum processo em background.'
      return procs
        .map(
          (p) =>
            `• ${p.label} (PID ${p.pid}) — ${p.status}${p.status === 'running' ? `, ativo há ${formatUptime(p.startTime)}` : ''}${p.exitCode !== undefined ? `, exit code ${p.exitCode}` : ''}`,
        )
        .join('\n')
    },
  })

  const bashKill = tool({
    description: 'Mata um processo em background pelo PID.',
    inputSchema: z.object({
      pid: z.number().describe('PID do processo a ser morto'),
    }),
    execute: async ({ pid }) => {
      const ok = killProcess(pid)
      if (ok) return `Processo PID ${pid} morto.`
      return `Processo PID ${pid} não encontrado.`
    },
  })

  return { bash_background: bashBackground, bash_list: bashList, bash_kill: bashKill }
}

function formatUptime(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
