import { app } from 'electron'

/**
 * How the app behaves while it runs under the dev server (`vite dev`).
 *
 * The packaged app is resident on purpose: it stays alive without a window (tray, Dock) so
 * routines and connected apps keep working. In dev that is a trap: the app outlives the
 * terminal command that started it, so stopping the dev server left an invisible Orbit
 * behind that no longer reloaded, and every restart began by killing it by hand.
 *
 * In dev the app therefore (1) never stays alive without a window, (2) has no tray, and
 * (3) exits as soon as the dev server that launched it is gone.
 */

/** True when running from source under the dev server. */
export const isDevRun = (): boolean => !app.isPackaged

export interface ParentWatchDeps {
  /** The pid of the process that launched this one, as of now. */
  currentParent: () => number
  /** Whether a process with that pid still exists. */
  isAlive: (pid: number) => boolean
}

const defaultDeps: ParentWatchDeps = {
  currentParent: () => process.ppid,
  isAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      // EPERM: it exists but is not ours to signal.
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
}

/**
 * The launcher is gone when its pid no longer exists, or when this process was handed to
 * another parent (the system adopts an orphan, so `ppid` changes).
 */
export function isLauncherGone(launcher: number, deps: ParentWatchDeps = defaultDeps): boolean {
  return deps.currentParent() !== launcher || !deps.isAlive(launcher)
}

/**
 * Calls `onGone` once, when the dev server that launched the app disappears (Ctrl+C in the
 * terminal, a crash, a closed terminal tab). Returns the function that stops watching.
 */
export function watchDevLauncher(onGone: () => void, intervalMs = 1000, deps: ParentWatchDeps = defaultDeps): () => void {
  const launcher = deps.currentParent()
  // Launched with no parent to speak of (pid 1 or none): nothing to follow.
  if (!launcher || launcher <= 1) return () => {}
  const timer = setInterval(() => {
    if (!isLauncherGone(launcher, deps)) return
    clearInterval(timer)
    onGone()
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
