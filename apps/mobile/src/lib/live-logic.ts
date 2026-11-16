import type { LiveAction, LiveKind, LiveState } from '@orbit/shared'

/**
 * Pure rules of the live browser/computer view: when to pull the next frame, how to read a
 * URL for the address bar, how to show the elapsed time. The screen and the store only wire
 * these to React / the connection, so the pacing and the edge cases are testable.
 */

/** Frames are pulled at about 1 fps while the agent is busy. */
export const POLL_BUSY_MS = 900
/** Slower once nothing happened for a while — the page is only idling. */
export const POLL_IDLE_MS = 3_000
/** After this long without any event the surface counts as idle. */
export const IDLE_AFTER_MS = 20_000
const POLL_BACKOFF_MS = [1_500, 3_000, 6_000, 10_000]

/**
 * Delay before the next pull; null = do not poll (surface closed, app backgrounded).
 * Failures back off so a sleeping desktop is not hammered.
 */
export function nextPollDelay(input: { state: LiveState | null; now: number; failures: number; visible: boolean }): number | null {
  const { state, now, failures, visible } = input
  if (!visible || !state?.active) return null
  if (failures > 0) return POLL_BACKOFF_MS[Math.min(failures, POLL_BACKOFF_MS.length) - 1]
  return now - state.lastAt > IDLE_AFTER_MS ? POLL_IDLE_MS : POLL_BUSY_MS
}

/** Is the agent acting on it right now (drives the pulsing dot)? */
export function isBusy(state: LiveState | null, now: number): boolean {
  return Boolean(state?.active && now - state.lastAt <= IDLE_AFTER_MS)
}

/**
 * A pushed state replaces ours unless it is older: events can arrive out of order after a
 * reconnect. The feed of an event is only a tail, so it is merged into the full ring we
 * already have by action id.
 */
export function mergeLiveState(prev: LiveState | undefined, next: LiveState): LiveState {
  if (!prev) return next
  if (next.lastAt < prev.lastAt && next.frameRev <= prev.frameRev) return prev
  const known = new Set(prev.feed.map((a) => a.id))
  const feed: LiveAction[] = [...prev.feed, ...next.feed.filter((a) => !known.has(a.id))].sort((a, b) => a.id - b.id)
  return { ...next, feed: feed.slice(-40) }
}

/** `example.com` for the address bar; the raw text when it is not a URL. */
export function hostLabel(url: string | null): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return u.host + (u.pathname !== '/' ? u.pathname : '')
  } catch {
    return url
  }
}

/** `42s`, `3m05s`. */
export function elapsedLabel(startedAt: number | null, now: number): string {
  if (!startedAt) return ''
  const s = Math.max(0, Math.floor((now - startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** Newest first, as the feed is read. */
export function feedNewestFirst(feed: LiveAction[]): LiveAction[] {
  return [...feed].reverse()
}

export function surfaceKey(kind: LiveKind, sessionId: string): string {
  return `${kind}:${sessionId}`
}

/** Aspect ratio for the frame box; a sane default before the first frame. */
export function frameAspect(frame: { width: number; height: number } | null): number {
  if (!frame || frame.width <= 0 || frame.height <= 0) return 16 / 10
  // A very tall phone-sized page must not push the feed off the screen.
  return Math.max(frame.width / frame.height, 0.55)
}
