import { computerRegistry, getComputerDriver, isComputerAvailable } from '../computer'
import { observe } from '../computer/observe'
import { isEnhanced, noteEnhanced, releaseEnhanced } from '../computer/session'
import { overlayOpenContext } from './open-context'
import { frontmostForeignApp } from './selection'

/**
 * What the turn of the shortcut panel (⇧⌘space) carries beyond the question.
 *
 * On a request about the screen ("can you see my screen?", "what does this error
 * say?"), Orbit reads the front window as TEXT before the model answers and sends it
 * along with the message. Waiting for the model to decide to look failed in two
 * ways: a fast model in voice mode answered without calling any tool ("the capture
 * does not reach me legibly" — repeating an old attempt from the history), and even
 * when it did call, it was one more round trip in a spoken conversation. The image
 * stays in see_screen, for what the text does not carry.
 */

/** Enough for a dialog, an error or a page's visible text; a big app is cut, and the result says so. */
export const WINDOW_TEXT_NODES = 400

/**
 * Request about what is on the screen or selected. Broad on purpose: reading the
 * window costs milliseconds and a few hundred tokens; not reading when it was needed
 * costs a made-up answer.
 */
const SCREEN_INTENT =
  /\b(tela|telas|janela|vendo|v[eê]s|ver|olha|olhe|enxerga|aqui|isso|isto|erro|aparece|aparecendo|traduz|traduza|resume|resuma|leia|screen|window|see|look|error|translate|summari[sz]e|read)\b/i

export function wantsScreen(text: string): boolean {
  return SCREEN_INTENT.test(text)
}

/** Wait after turning on the tree of a Chromium/Electron app: it is built asynchronously. */
const ENHANCE_WAIT_MS = 450
/** How long the tree of a Chromium/Electron app stays on after the last read. */
const ENHANCE_HOLD_MS = 45_000
/** Fewer lines with text than this = the window does not expose content (only chrome, title bar). */
const MIN_TEXT_LINES = 6

const releaseTimers = new Map<string, NodeJS.Timeout>()

/**
 * Chromium/Electron apps (Claude, Chrome, VS Code, Slack…) only build the
 * accessibility tree when someone asks for it; without that the reading returned only
 * the window chrome. The flag is turned on to read and given back right after —
 * leaving it on makes the user's app work harder forever. A second question right
 * after reuses the 45 s window.
 */
function scheduleRelease(sessionId: string): void {
  const previous = releaseTimers.get(sessionId)
  if (previous) clearTimeout(previous)
  releaseTimers.set(
    sessionId,
    setTimeout(() => {
      releaseTimers.delete(sessionId)
      releaseEnhanced(sessionId)
    }, ENHANCE_HOLD_MS),
  )
}

export type FrontWindowRead =
  | { text: string; poor: boolean }
  | { unavailable: string }

/** The front window (behind the panel) as text, or the reason there is none. `poor` = chrome only, no content. */
export async function readFrontWindowText(sessionId: string): Promise<FrontWindowRead> {
  if (!isComputerAvailable()) {
    return { unavailable: 'Reading windows as text is not available here (it needs the Accessibility permission for Orbit).' }
  }
  try {
    const front = await frontmostForeignApp()
    const pid = overlayOpenContext()?.pid ?? front?.pid
    if (!pid) return { unavailable: 'There is no app window behind the panel to read.' }
    const result = await observe(getComputerDriver(), computerRegistry, {
      sessionId,
      app: String(pid),
      includeTree: true,
      includeScreenshot: false,
      maxNodes: WINDOW_TEXT_NODES,
      maxScreenshotEdge: 1280,
      enhance: true,
      enhanceWaitMs: isEnhanced(pid) ? 0 : ENHANCE_WAIT_MS,
    })
    if (result.tree?.enhanced) {
      noteEnhanced(sessionId, pid)
      scheduleRelease(sessionId)
    }
    const labelled = [...(result.record.bodies?.values() ?? [])].filter((body) => body.includes('"')).length
    return { text: result.text, poor: result.record.elements.size <= 2 || labelled < MIN_TEXT_LINES }
  } catch (err) {
    return { unavailable: `Could not read the window: ${err instanceof Error ? err.message : String(err)}.` }
  }
}

/**
 * The screen as an image, described by the vision model — only for when the text
 * reading brought no content. Image is the exception: it is slower and costs more than
 * text, but here it is what is left, and the shortcut's model (fast, voice) is not
 * reliable to decide on its own to call the tool afterwards.
 */
export async function describeFrontScreen(
  visionModel: { providerId: string; modelId: string },
  focus: string,
  language?: string,
): Promise<string | null> {
  const [{ captureScreenForOverlay }, { describeImage }] = await Promise.all([import('./capture'), import('../vision')])
  const shot = await captureScreenForOverlay().catch(() => null)
  if (!shot) return null
  return describeImage({
    model: visionModel,
    imageDataUrl: `data:${shot.mediaType};base64,${shot.data.toString('base64')}`,
    focus,
    language,
  })
}

/** The block that goes along with the user's message when Orbit looked at the screen before. */
export function prefetchedScreenBlock({ windowText, description }: { windowText?: string | null; description?: string | null }): string {
  const lines = [
    '[Orbit looked at the screen right before your reply — this counts as looking in THIS turn. Answer from it; do not say you cannot see or that the capture does not arrive. Call see_screen only if you need a closer look at how something LOOKS.]',
  ]
  if (windowText) lines.push('Window text (accessibility tree):', windowText)
  if (description) lines.push('A vision model looked at the screen image and described it:', description)
  return lines.join('\n')
}

/**
 * The shortcut panel does not need the whole conversation: it is a question about
 * now. Sending everything cost ~180 thousand tokens per spoken turn and carried old
 * attempts the model would repeat instead of looking again. The recent thread stays —
 * "and now translate that" still points at what was just said.
 */
const OVERLAY_HISTORY_MS = 30 * 60_000
const OVERLAY_HISTORY_MAX = 12

export function recentOverlayHistory<T extends { createdAt: number }>(messages: T[], now = Date.now()): T[] {
  if (messages.length === 0) return messages
  const recent = messages.slice(-OVERLAY_HISTORY_MAX).filter((m) => now - m.createdAt <= OVERLAY_HISTORY_MS)
  const last = messages[messages.length - 1]
  // The message of the current turn always goes, even with a strange clock.
  return recent.length > 0 && recent[recent.length - 1] === last ? recent : [...recent.filter((m) => m !== last), last]
}
