import { clipboard } from 'electron'
import { getComputerDriver, isComputerAvailable } from '../computer'
import type { AppInfo, WindowInfo } from '../computer/types'

/**
 * Reads the selected text in the app the person is using, so the overlay (⇧⌘space)
 * can translate/summarize without them copying anything.
 *
 * Two layers, in order:
 *  1. AXSelectedText of the focused element of the app (no side effect);
 *  2. copy via Cmd+C + clipboard, restoring what was there.
 *
 * Layer 2 only runs when requested (`allowClipboard`) and only with the app in the
 * foreground — pressing Cmd+C in an app that is not in front would copy something
 * else. Neither of them works without the Accessibility permission, which is the
 * same one Computer Use needs.
 */

export interface SelectionRead {
  text: string
  /** App the text came from (display name). */
  app: string | null
  /** `ax` = direct read; `clipboard` = copied and restored the clipboard. */
  source: 'ax' | 'clipboard'
}

const MAX_SELECTION = 20_000
const COPY_WAIT_MS = 220

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Is the app Orbit itself (the overlay window or the main one)? */
function isOrbitApp(app: AppInfo): boolean {
  if (/^orbit$/i.test(app.name) || /^electron$/i.test(app.name)) return true
  return (app.bundleId ?? '').toLowerCase().startsWith('com.fragmentslabs')
}

/** App in the foreground, ignoring Orbit. `null` when only Orbit exists. */
export async function frontmostForeignApp(): Promise<AppInfo | null> {
  return (await frontmostForeignWindow())?.app ?? null
}

/** The app in the foreground (ignoring Orbit) and its front window, in a single read. */
export async function frontmostForeignWindow(): Promise<{ app: AppInfo; window: WindowInfo | null } | null> {
  if (!isComputerAvailable() || process.platform !== 'darwin') return null
  try {
    const snapshot = await getComputerDriver().apps()
    // `apps` comes in NSWorkspace order (arbitrary); `windows` comes from the front
    // to the back. The first pid with a window that is not Orbit is the app the
    // person was in — even if the panel has already stolen the focus.
    const byPid = new Map(snapshot.apps.map((app) => [app.pid, app]))
    for (const window of snapshot.windows) {
      const app = byPid.get(window.pid)
      if (!app || app.hidden || isOrbitApp(app)) continue
      return { app, window }
    }
    const app = snapshot.apps.find((a) => a.active && !isOrbitApp(a))
    return app ? { app, window: null } : null
  } catch {
    return null
  }
}

/** Selected text via AX in the given app (without touching the clipboard). */
async function readFromAx(pid: number): Promise<string | null> {
  try {
    const result = await getComputerDriver().act({ op: 'readSelection', pid })
    const text = result.selection?.text
    return text && text.trim() ? text.trim() : null
  } catch {
    return null
  }
}

/**
 * Cmd+C in the app and reading of the clipboard, giving back what was there at the
 * end. Without that, a "translate this" with no selection would leave the
 * conversation with the wrong text on the clipboard — and the person's next Cmd+V
 * would paste garbage.
 */
async function readFromClipboard(pid: number): Promise<string | null> {
  // In Electron 44 the clipboard is asynchronous in both directions.
  const before = await clipboard.readText()
  try {
    await getComputerDriver().act({
      op: 'keys',
      pid,
      combos: [{ code: 8 /* C */, flags: 0x100000 /* Command */ }],
      mode: 'global',
    })
  } catch {
    return null
  }
  await sleep(COPY_WAIT_MS)
  const copied = await clipboard.readText()
  if (before !== copied) {
    // Restores after reading: the person's next paste is still theirs.
    await clipboard.writeText(before)
  }
  if (!copied.trim() || copied === before) return null
  return copied.trim()
}

/**
 * Text selected right now. `allowClipboard` must be true only when the person asked
 * explicitly (the `see_selection` tool), never when the overlay opens — opening the
 * panel cannot touch the clipboard.
 */
export async function readSelectedText(options?: { allowClipboard?: boolean }): Promise<SelectionRead | null> {
  if (!isComputerAvailable() || process.platform !== 'darwin') return null
  const target = await frontmostForeignApp()
  if (!target) return null

  const ax = await readFromAx(target.pid)
  if (ax) return { text: ax.slice(0, MAX_SELECTION), app: target.name, source: 'ax' }

  if (!options?.allowClipboard) return null
  // Cmd+C goes to the app in the foreground: with another app in front (the overlay
  // received the focus), pressing it now would copy from the wrong place.
  if (!target.active) return null
  const copied = await readFromClipboard(target.pid)
  return copied ? { text: copied.slice(0, MAX_SELECTION), app: target.name, source: 'clipboard' } : null
}
