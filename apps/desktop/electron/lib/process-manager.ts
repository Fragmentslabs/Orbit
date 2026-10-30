import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ChildProcess } from 'node:child_process'
import { userShellEnv } from './shell-env'

const execFileAsync = promisify(execFile)

export interface ProcessInfo {
  pid: number
  label: string
  command: string
  cwd: string
  startTime: number
  status: 'running' | 'exited' | 'killed'
  exitCode?: number
  /** Chat session that started the process — scope of the panel and of the bash_* tools. */
  sessionId?: string
  /**
   * Local server URLs announced in the output (Vite, Next, Expo…). Computed
   * from the log in listProcesses — the buffer grows, so deriving on read
   * keeps the list always current, without rescanning on every chunk.
   */
  urls?: string[]
}

// Output buffer per process — a simple cap in characters, it avoids accumulating
// gigabytes of log from long builds (e.g. eas build) in the main's memory.
const MAX_OUTPUT_CHARS = 200_000

// ANSI color/control codes: dev servers paint the URL, and the escape between
// "localhost" and the ":" would break the regex match. The ESC comes from fromCharCode
// because a literal \x1b in a regex is barred by no-control-regex.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

// Local host with a mandatory port, with or without a scheme (a loose "localhost"
// shows up in build logs and is not a server).
const LOCAL_URL_RE = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{1,5}\b/gi

/**
 * Local server URLs that the process announced in the output.
 *
 * It normalizes to `localhost` (0.0.0.0 and [::1] are listen binds, not a navigable
 * address) and returns only the origin — it is what the panel webview needs to
 * open the application in development.
 */
export function extractLocalUrls(output: string): string[] {
  const found = new Set<string>()
  for (const match of output.replace(ANSI_RE, '').matchAll(LOCAL_URL_RE)) {
    const raw = match[0]
    // The LAST ":" and not the first: an IPv6 bind is "[::1]:8080" — the naive
    // match from the left would catch the ":1" of the address.
    const port = raw.slice(raw.lastIndexOf(':') + 1)
    if (!/^\d{1,5}$/.test(port)) continue
    found.add(`${/^https:\/\//i.test(raw) ? 'https' : 'http'}://localhost:${port}`)
  }
  return [...found]
}

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
 * Registers an already started process (by spawnBackground or by the automatic
 * promotion of the foreground bash that blew the timeout) in the manager,
 * taking over the output buffer and the status listeners.
 * If the process already ended before the registration (race), it reflects the state.
 */
export function registerProcess(
  child: ChildProcess,
  opts: { label: string; command: string; cwd: string; pid: number; initialOutput?: string; sessionId?: string },
): ProcessInfo {
  const info: ProcessInfo = {
    pid: opts.pid,
    label: opts.label,
    command: opts.command,
    cwd: opts.cwd,
    startTime: Date.now(),
    status: 'running',
    sessionId: opts.sessionId,
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

export function spawnBackground(label: string, command: string, cwd?: string, sessionId?: string): ProcessInfo {
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

  // On leaving the app the processes shown in the panel are killed; unref'ing does not
  // let the main finish before the child.
  child.unref()

  const info = registerProcess(child, {
    label,
    command,
    cwd: cwd ?? process.cwd(),
    pid: child.pid ?? 0,
    sessionId,
  })
  return info
}

export function getProcessOutput(pid: number, sessionId?: string): string {
  const entry = processes.get(pid)
  if (!entry) return ''
  // Scope per session: output only for the owner (or ownerless processes, e.g. legacy ones).
  if (sessionId !== undefined && entry.info.sessionId !== undefined && entry.info.sessionId !== sessionId) {
    return ''
  }
  return entry.output
}

export async function killProcess(pid: number, sessionId?: string): Promise<boolean> {
  const entry = processes.get(pid)
  if (!entry) return false
  // Scope per session: only the owner (or ownerless processes) may end it.
  if (sessionId !== undefined && entry.info.sessionId !== undefined && entry.info.sessionId !== sessionId) {
    return false
  }

  if (entry.info.status === 'running') {
    const isWin = process.platform === 'win32'
    try {
      if (isWin) {
        // Waits for taskkill to finish (exit code 0 = dead). On failure (exit != 0:
        // access denied, process already dead…) the entry is NOT removed — the card
        // stays in the panel for another attempt, and the real status becomes 'exited'
        // on its own through the child event when the process actually dies. Before
        // this, the entry was deleted right away: the process vanished from the UI while
        // still alive, and "there was no way to stop it" because there was nowhere to press.
        try {
          await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
        } catch {
          return false
        }
      } else {
        // detached:true runs the command with setsid, so it leads its own
        // process group — killing only the PID (positive) kills the shell but leaves
        // its children (e.g. the real build process) orphaned and running.
        // A negative PID sends the signal to the whole group.
        try {
          process.kill(-pid, 'SIGTERM')
        } catch {
          process.kill(pid, 'SIGTERM')
        }
        setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            try { process.kill(pid, 'SIGKILL') } catch { /* already ended */ }
          }
        }, 3000)
      }
      entry.info.status = 'killed'
    } catch {
      return false
    }
  }

  // The trash can in the UI serves both to end and to "forget" the process —
  // without this it reappears on the panel's next poll (listProcesses never
  // forgot entries on its own) and the agent would keep seeing it in bash_list.
  processes.delete(pid)
  return true
}

export function listProcesses(sessionId?: string): ProcessInfo[] {
  const results: ProcessInfo[] = []
  for (const [, entry] of processes) {
    if (sessionId !== undefined && entry.info.sessionId !== sessionId) continue
    results.push({ ...entry.info, urls: extractLocalUrls(entry.output) })
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
    } catch { /* process may already have ended — kill on quit is best-effort */ }
  }
  processes.clear()
}
