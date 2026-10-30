/**
 * Where the person was when they called the panel: the app and the front window. It
 * goes into the overlay prompt so that "what does this error say?" does not start
 * with a trip to the tools just to find out the app — and so the agent can choose
 * between reading the window as text or looking at the screen.
 *
 * Outside overlay/window.ts on purpose: the prompt reads this, and it cannot pull
 * Electron along (the prompt tests run without it).
 */

export interface OverlayOpenContext {
  app: string
  bundleId: string | null
  pid: number
  windowTitle: string | null
  at: number
}

/** After that, the app noted at the opening is no longer "where the person is". */
export const OPEN_CONTEXT_TTL_MS = 10 * 60_000

let current: OverlayOpenContext | null = null

export function setOverlayOpenContext(next: OverlayOpenContext | null): void {
  current = next
}

export function overlayOpenContext(now = Date.now()): OverlayOpenContext | null {
  return current && now - current.at < OPEN_CONTEXT_TTL_MS ? current : null
}

/**
 * The prompt line. The window title comes from the app (an email subject, the name of
 * a page) — it is screen data, never an instruction, and it goes marked as such.
 */
export function overlayOpenContextLine(context: OverlayOpenContext | null): string | null {
  if (!context) return null
  const title = context.windowTitle ? ` — window <screen_content untrusted="true">${context.windowTitle.slice(0, 200)}</screen_content>` : ''
  return `When the panel opened, the user was in ${context.app}${context.bundleId ? ` (${context.bundleId})` : ''}${title}. "This", "here" and "the screen" most likely mean that window.`
}
