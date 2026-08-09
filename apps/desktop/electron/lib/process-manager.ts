import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { userShellEnv } from './shell-env'

export interface ProcessInfo {
  pid: number
  label: string
  command: string
  cwd: string
  startTime: number
  status: 'running' | 'exited' | 'killed'
  exitCode?: number
}

// Buffer de saída por processo — cap simples em caracteres, evita acumular
// gigabytes de log de builds longos (ex.: eas build) na memória do main.
const MAX_OUTPUT_CHARS = 200_000

const processes = new Map<number, { info: ProcessInfo; child: ChildProcess; output: string }>()

function appendOutput(entry: { output: string }, chunk: string) {
  entry.output += chunk
  if (entry.output.length > MAX_OUTPUT_CHARS) {
    entry.output = entry.output.slice(entry.output.length - MAX_OUTPUT_CHARS)
  }
}

function attachOutput(entry: { info: ProcessInfo; child: ChildProcess; output: string }) {
  entry.child.stdout?.on('data', (chunk: Buffer) => appendOutput(entry, chunk.toString('utf8')))
  entry.child.stderr?.on('data', (chunk: Buffer) => appendOutput(entry, chunk.toString('utf8')))

  entry.child.on('exit', (exitCode) => {
    const e = processes.get(entry.info.pid)
    if (e) {
      e.info.status = 'exited'
      e.info.exitCode = exitCode ?? undefined
    }
  })

  entry.child.on('error', () => {
    const e = processes.get(entry.info.pid)
    if (e) {
      e.info.status = 'exited'
      e.info.exitCode = undefined
    }
  })
}

/**
 * Registra um processo já iniciado (por spawnBackground ou pela promoção
 * automática do bash foreground que estourou o timeout) no gerenciador,
 * assumindo o buffer de saída e os listeners de status.
 * Se o processo já encerrou antes do registro (corrida), reflete o estado.
 */
export function registerProcess(
  child: ChildProcess,
  opts: { label: string; command: string; cwd: string; pid: number; initialOutput?: string },
): ProcessInfo {
  const info: ProcessInfo = {
    pid: opts.pid,
    label: opts.label,
    command: opts.command,
    cwd: opts.cwd,
    startTime: Date.now(),
    status: 'running',
  }
  const entry = { info, child, output: opts.initialOutput ?? '' }
  processes.set(opts.pid, entry)
  attachOutput(entry)
  if (child.exitCode !== null && child.exitCode !== undefined) {
    info.status = 'exited'
    info.exitCode = child.exitCode
  }
  return info
}

export function spawnBackground(label: string, command: string, cwd?: string): ProcessInfo {
  const isWin = process.platform === 'win32'

  const child = isWin
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: userShellEnv(),
      })
    : spawn('/bin/bash', ['-c', command], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: userShellEnv(),
      })

  // Ao sair do app os processos exibidos no painel são mortos; desafixar não
  // deixa o main terminar antes do filho.
  child.unref()

  const info = registerProcess(child, {
    label,
    command,
    cwd: cwd ?? process.cwd(),
    pid: child.pid ?? 0,
  })
  return info
}

export function getProcessOutput(pid: number): string {
  return processes.get(pid)?.output ?? ''
}

export function killProcess(pid: number): boolean {
  const entry = processes.get(pid)
  if (!entry) return false

  if (entry.info.status === 'running') {
    try {
      const isWin = process.platform === 'win32'
      if (isWin) {
        // /T mata a árvore inteira (o processo e todos os filhos dele).
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        // detached:true roda o comando com setsid, então ele lidera seu próprio
        // grupo de processos — matar só o PID (positivo) mata a shell mas deixa
        // os filhos dela (ex.: o processo real do build) órfãos e rodando.
        // PID negativo manda o sinal pro grupo inteiro.
        try {
          process.kill(-pid, 'SIGTERM')
        } catch {
          process.kill(pid, 'SIGTERM')
        }
        setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            try { process.kill(pid, 'SIGKILL') } catch {}
          }
        }, 3000)
      }
      entry.info.status = 'killed'
    } catch {
      return false
    }
  }

  // A lixeira na UI serve tanto pra encerrar quanto pra "esquecer" o processo —
  // sem isso ele reaparece no próximo poll do painel (listProcesses nunca
  // esquecia entradas sozinho) e o agente continuaria vendo-o no bash_list.
  processes.delete(pid)
  return true
}

export function listProcesses(): ProcessInfo[] {
  const results: ProcessInfo[] = []
  for (const [, entry] of processes) {
    results.push({ ...entry.info })
  }
  return results
}

export function killAll(): void {
  for (const [pid] of processes) {
    try {
      const isWin = process.platform === 'win32'
      if (isWin) {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        try {
          process.kill(-pid, 'SIGTERM')
        } catch {
          process.kill(pid, 'SIGTERM')
        }
      }
    } catch {}
  }
  processes.clear()
}
