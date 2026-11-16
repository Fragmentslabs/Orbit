/**
 * Live view of the panels where the agent drives a browser or a computer.
 *
 * The phone cannot see those windows, so the desktop mirrors them through the companion:
 * small `live:event` pushes over the WebSocket say WHEN something changed (state, action
 * feed, a new frame is available) and the phone pulls the heavy part — a downscaled JPEG —
 * over HTTP, only while the screen is open and only when the revision moved. Frames are
 * therefore naturally dropped under load: the phone asks for the newest one, never a queue.
 *
 * View-first on purpose: there is no tap/type forwarding, because the desktop has no safe
 * remote-input API for either panel (the agent is the only thing allowed to drive them).
 */

export type LiveKind = 'browser' | 'computer'

/** One line of the actions feed ("click on Save", "Navigate to example.com"). */
export interface LiveAction {
  /** Monotonic per surface — the phone uses it as the list key and to append only new rows. */
  id: number
  at: number
  label: string
}

/** What the panel shows right now, minus the pixels. */
export interface LiveState {
  sessionId: string
  kind: LiveKind
  /**
   * The surface exists: the browser panel is open for the chat, or the computer control is
   * running. false = it closed (the phone keeps the last feed and shows a "closed" state).
   */
  active: boolean
  /** Browser: current URL (empty when about:blank). */
  url: string | null
  /** Browser: page title. */
  title: string | null
  /** Computer: app being controlled. */
  app: string | null
  /** The action being performed right now (last feed label), null when none yet. */
  action: string | null
  /** When the surface became active (ms), for the elapsed clock. */
  startedAt: number | null
  /** Last time anything happened on it (ms). */
  lastAt: number
  /** Bumps whenever a new frame may be fetched. 0 = no frame yet. */
  frameRev: number
  /** Latest actions, oldest first (the event carries a short tail, the HTTP state the full ring). */
  feed: LiveAction[]
}

/** `live:event` pushed over the WebSocket. */
export interface LiveEventMessage {
  type: 'live:event'
  state: LiveState
}

/** GET /api/live — every surface the desktop knows about. */
export interface LiveListResponse {
  sessions: LiveState[]
}

/** GET /api/live/frame?sessionId&kind&since — `unchanged` when the phone already has this revision. */
export type LiveFrameResponse =
  | { unchanged: true; rev: number; state: LiveState }
  | {
      unchanged?: false
      rev: number
      state: LiveState
      /** `data:image/jpeg;base64,...`, already downscaled for the phone. */
      dataUrl: string
      width: number
      height: number
      /** Computer: the target of the last action in frame pixels, to draw the pointer. */
      marker: { x: number; y: number; w: number; h: number; label: string } | null
    }
  | { unavailable: true; reason: LiveFrameUnavailable; rev: number; state: LiveState }

export type LiveFrameUnavailable = 'closed' | 'no-frame' | 'capture-failed'

/** POST /api/live/stop */
export interface LiveStopRequest {
  sessionId: string
  kind: LiveKind
}

/** Longest edge of a frame sent to the phone, in px. */
export const LIVE_FRAME_MAX_EDGE = 720
/** JPEG quality of a frame sent to the phone. */
export const LIVE_FRAME_QUALITY = 55
/** Entries kept per surface on the desktop. */
export const LIVE_FEED_LIMIT = 40
/** Entries riding along in a pushed event (the full ring comes with the HTTP state). */
export const LIVE_EVENT_FEED_TAIL = 6

export function liveKey(kind: LiveKind, sessionId: string): string {
  return `${kind}:${sessionId}`
}
