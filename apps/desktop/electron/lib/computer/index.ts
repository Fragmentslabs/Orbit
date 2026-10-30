import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, desktopCapturer, shell, systemPreferences } from 'electron'
import type { ComputerStatus, ComputerTestResult } from '@shared/computer'
import { createMacosDriver } from './drivers/macos'
import { createWindowsDriver, disposeWindowsHost } from './drivers/windows'
import { computerRegistry } from './registry'
import { disposeComputerSessions, setComputerRestoreHandler } from './session'
import { shotView } from './shots'
import { ComputerError, type ComputerDriver } from './types'

/**
 * Facade of Computer Use. There is a driver for macOS and one for Windows (see
 * docs/computer-use-windows.md) and it is turned off in the Mac App Store: the sandbox
 * there blocks accessibility and event injection, and announcing a tool that does not
 * work is worse than not having it.
 */

export { computerRegistry }

let driver: ComputerDriver | null = null

export function computerSupport(): { available: boolean; reason: ComputerStatus['reason'] } {
  if (process.mas) return { available: false, reason: 'mas' }
  if (process.platform !== 'darwin' && process.platform !== 'win32') return { available: false, reason: 'platform' }
  return { available: true, reason: null }
}

export function isComputerAvailable(): boolean {
  return computerSupport().available
}

export function getComputerDriver(): ComputerDriver {
  if (!driver) {
    if (!isComputerAvailable()) throw new ComputerError('unavailable', 'Computer use is not available on this platform.')
    driver = process.platform === 'win32' ? createWindowsDriver() : createMacosDriver()
    const d = driver
    setComputerRestoreHandler((pids) => d.restore(pids))
  }
  return driver
}

/** Swaps the driver (tests). */
export function setComputerDriver(next: ComputerDriver | null): void {
  driver = next
  if (next) setComputerRestoreHandler((pids) => next.restore(pids))
}

const run = promisify(execFile)

/**
 * The app macOS treats as the owner of this process's permissions. TCC assigns it to
 * the responsible process: opened by Finder, it is the app itself; opened by a shell
 * (`npm run dev`), it is the terminal app that launched it — and then granting
 * "Electron" in Settings does not help (seen in Phase 0: Orbit in dev belonged to
 * Terminal). It climbs through the parents up to the first .app bundle.
 */
export async function responsibleApp(): Promise<string | null> {
  let pid = process.ppid
  for (let i = 0; i < 12 && pid > 1; i++) {
    const { stdout } = await run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]).catch(() => ({ stdout: '' }))
    const match = /^\s*(\d+)\s+(.+)$/.exec(stdout.trim())
    if (!match) return null
    const bundle = /([^/]+)\.app\/Contents\/MacOS\//.exec(match[2])
    if (bundle) return bundle[1]
    pid = Number(match[1])
  }
  return null
}

export async function computerStatus(): Promise<ComputerStatus> {
  const support = computerSupport()
  const base: ComputerStatus = {
    available: support.available,
    reason: support.reason,
    platform: process.platform,
    accessibility: false,
    screen: 'unknown',
    dev: !app.isPackaged,
    responsible: null,
  }
  if (!support.available) return base
  if (process.platform === 'win32') {
    // Without TCC: "accessibility" says whether the UI Automation host starts, and the notes
    // say what else limits it (restricted PowerShell, Orbit without administrator).
    base.screen = 'granted'
    try {
      const perms = await getComputerDriver().perms()
      base.accessibility = perms.accessibility
      base.notes = perms.notes
    } catch (err) {
      base.accessibility = false
      base.notes = [err instanceof Error ? err.message : String(err)]
    }
    return base
  }
  base.responsible = await responsibleApp()
  try {
    base.accessibility = systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    base.accessibility = false
  }
  try {
    base.screen = systemPreferences.getMediaAccessStatus('screen')
  } catch {
    base.screen = 'unknown'
  }
  return base
}

/** Asks for the Accessibility permission (macOS opens its own dialog). */
export function requestAccessibility(): boolean {
  if (!isComputerAvailable()) return false
  // Windows has no permission to ask for (UIA does not ask for authorization).
  if (process.platform === 'win32') return true
  return systemPreferences.isTrustedAccessibilityClient(true)
}

/**
 * Asks for Screen Recording. macOS only lists the app in Settings after it tries to
 * capture — and, in dev, the "Electron" in the list has to be this project's binary
 * (Phase 0: granting the Electron of another project does not count). Asking for the
 * capture sources creates the right entry; then it opens the panel.
 */
export async function requestScreenRecording(): Promise<{ granted: boolean }> {
  if (!isComputerAvailable()) return { granted: false }
  // 1) The official request (system dialog, on behalf of Orbit); 2) the
  // desktopCapturer, which in some versions is what puts the app in the list.
  const asked = await getComputerDriver().requestScreen().catch(() => ({ before: false, granted: false }))
  if (asked.granted) return { granted: true }
  await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => undefined)
  // Without the permission, it opens the panel: macOS may NOT have put Orbit in the
  // list (seen in the non-notarized build) — then only the "+" solves it, and the
  // Preferences explain that.
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch(() => undefined)
  return { granted: false }
}

/**
 * "Test" of the Preferences: a real call to the bridge, not just reading the flag. It
 * is what proves that the permission granted to Orbit holds for the child process
 * that does the work.
 */
export async function testComputer(): Promise<ComputerTestResult> {
  const started = Date.now()
  try {
    const d = getComputerDriver()
    const perms = await d.perms()
    if (!perms.accessibility) {
      // On Windows the reason is in the host notes (restricted PowerShell etc.).
      return { ok: false, ms: Date.now() - started, message: (process.platform === 'win32' && perms.notes?.[0]) || 'axDenied' }
    }
    const snapshot = await d.apps()
    const front = snapshot.apps.find((a) => a.active && a.pid !== process.pid) ?? snapshot.apps.find((a) => a.pid !== process.pid)
    const win = front ? snapshot.windows.find((w) => w.pid === front.pid) : undefined
    if (front && win) {
      const tree = await d.tree({ pid: front.pid, window: { id: win.id, frame: win.frame, title: win.title }, maxNodes: 60 })
      return { ok: true, ms: Date.now() - started, message: `${front.name}: ${tree.nodes.length}` }
    }
    return { ok: true, ms: Date.now() - started, message: '' }
  } catch (err) {
    return { ok: false, ms: Date.now() - started, message: err instanceof ComputerError ? err.code : String(err) }
  }
}

/**
 * Brings to the front the app the conversation thumbnail shows — the button of the
 * chip's popover. Only an app the agent has already observed on this machine (the
 * denylist has already been through it); nothing to do with acting on it.
 */
export async function focusShotApp(sessionId: string): Promise<boolean> {
  const shot = shotView(sessionId)
  const target = shot ? computerRegistry.lastTargetFor(shot.app) : null
  if (!target || !isComputerAvailable()) return false
  try {
    await getComputerDriver().act({ op: 'activate', pid: target.pid })
    return true
  } catch {
    return false
  }
}

export async function disposeComputerUse(): Promise<void> {
  await disposeComputerSessions()
  disposeWindowsHost()
}

export { ComputerError } from './types'
export { stopComputer, getComputerActivity, setComputerStopHandler, endActivity, markOverlaySession } from './session'
