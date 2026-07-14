import { spawn } from 'node:child_process'

export interface ProcessInfo {
  pid: number
  label: string
  command: string
  cwd: string
  startTime: number
  status: 'running' | 'exited' | 'killed'
  exitCode?: number
}

const processes = new Map<number, { info: ProcessInfo; child: import('node:child_process').ChildProcess }>()

export function spawnBackground(label: string, command: string, cwd?: string): ProcessInfo {
  const isWin = process.platform === 'win32'

  const child = isWin
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    : spawn('/bin/bash', ['-c', command], {
        cwd,
        detached: true,
        stdio: 'ignore',
      })

  child.unref()

  const info: ProcessInfo = {
    pid: child.pid ?? 0,
    label,
    command,
    cwd: cwd ?? process.cwd(),
    startTime: Date.now(),
    status: 'running',
  }

  processes.set(child.pid ?? 0, { info, child })

  child.on('exit', (exitCode) => {
    const entry = processes.get(child.pid ?? 0)
    if (entry) {
      entry.info.status = 'exited'
      entry.info.exitCode = exitCode ?? undefined
    }
  })

  child.on('error', () => {
    const entry = processes.get(child.pid ?? 0)
    if (entry) {
      entry.info.status = 'exited'
      entry.info.exitCode = undefined
    }
  })

  return info
}

export function killProcess(pid: number): boolean {
  const entry = processes.get(pid)
  if (!entry) return false

  try {
    const isWin = process.platform === 'win32'
    if (isWin) {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGTERM')
      setTimeout(() => {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }, 3000)
    }
    entry.info.status = 'killed'
    return true
  } catch {
    return false
  }
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
        process.kill(pid, 'SIGTERM')
      }
    } catch {}
  }
  processes.clear()
}
