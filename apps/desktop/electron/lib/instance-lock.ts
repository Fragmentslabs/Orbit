import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Which Orbit instance owns the profile.
 *
 * Packaged: Electron's own single-instance lock, as always — a second launch hands its
 * arguments to the first one and quits.
 *
 * Dev (`vite dev`): that lock is the wrong tool. vite-plugin-electron restarts the app on
 * every change to the main process by killing the old Electron and spawning the new one
 * RIGHT AWAY, without waiting for the old one to be gone. The new instance found the lock still
 * held (the old one spends a moment shutting down), quit — and the plugin takes the whole
 * dev server down with an Electron that exits. The old window then stayed open, black, with
 * nothing behind it, and every change meant closing it by hand and running `dev` again.
 *
 * So in dev the new instance WAITS for the previous one to be gone instead of quitting, using
 * a small pid file in the dev profile. It never touches Electron's lock, so the old process
 * is not poked by a `second-instance` while it is shutting down.
 */

const PID_FILE = '.dev-instance.pid'
const POLL_MS = 100
/** The old instance exits on its own within ~4s of a SIGTERM (see main.ts); this covers it. */
export const DEV_WAIT_MS = 12_000

export interface InstanceLockDeps {
  /** Is this pid a live Orbit dev process? (default: alive and running the same executable) */
  isOurs: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/** True when `pid` is alive. `EPERM` means it exists but is not ours to signal. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Alive AND the same executable. A stale file whose pid the system has since handed to some
 * unrelated process must not make a dev restart wait for it.
 */
function isOurDevProcess(pid: number): boolean {
  if (!isAlive(pid)) return false
  if (process.platform === 'win32') return true
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    return command.includes(process.execPath)
  } catch {
    return false
  }
}

function readPid(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

const defaultDeps: InstanceLockDeps = {
  isOurs: isOurDevProcess,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}

/**
 * Takes the dev profile for this process, waiting for a previous dev instance to exit.
 * Resolves false only if that one is still running after `DEV_WAIT_MS` (then there really is
 * another dev instance on this profile, and this one should not start).
 */
export async function claimDevInstance(
  profileDir: string,
  deps: InstanceLockDeps = defaultDeps,
  waitMs = DEV_WAIT_MS,
): Promise<boolean> {
  const file = path.join(profileDir, PID_FILE)
  const deadline = deps.now() + waitMs
  for (;;) {
    const owner = readPid(file)
    if (owner === null || owner === process.pid || !deps.isOurs(owner)) break
    if (deps.now() >= deadline) return false
    await deps.sleep(POLL_MS)
  }
  writeFileSync(file, String(process.pid))
  // Leaves the file only if it is still ours: a restart may already have written its own.
  process.once('exit', () => {
    if (existsSync(file) && readPid(file) === process.pid) rmSync(file, { force: true })
  })
  return true
}

/**
 * The instance claim of this launch: Electron's lock when packaged, the dev wait otherwise.
 * `requestLock` is `app.requestSingleInstanceLock` (it has to run before `ready`, so the
 * packaged answer is taken synchronously, right here).
 */
export function claimInstance(options: { packaged: boolean; requestLock: () => boolean; profileDir: string }): Promise<boolean> {
  if (options.packaged) return Promise.resolve(options.requestLock())
  return claimDevInstance(options.profileDir)
}
