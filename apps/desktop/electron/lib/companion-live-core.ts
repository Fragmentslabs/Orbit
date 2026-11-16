import {
  LIVE_EVENT_FEED_TAIL,
  LIVE_FEED_LIMIT,
  liveKey,
  type LiveFrameResponse,
  type LiveFrameUnavailable,
  type LiveKind,
  type LiveState,
} from '@shared/live'

/**
 * Pure core of the phone's live view of the browser/computer panels: the per-surface state
 * (feed ring, frame revision), the throttle for the pushed events and the request logic
 * (frame / stop). Nothing here touches Electron — companion-live.ts feeds it from the real
 * panels — so the whole thing is testable.
 */

interface Surface {
  sessionId: string
  kind: LiveKind
  active: boolean
  url: string | null
  title: string | null
  app: string | null
  startedAt: number | null
  lastAt: number
  frameRev: number
  nextActionId: number
  feed: LiveState['feed']
}

export type SurfacePatch = Partial<Pick<Surface, 'url' | 'title' | 'app'>>

export class LiveRegistry {
  private readonly surfaces = new Map<string, Surface>()
  private readonly listeners = new Set<(state: LiveState) => void>()

  constructor(private readonly now: () => number = Date.now) {}

  subscribe(listener: (state: LiveState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private get(kind: LiveKind, sessionId: string): Surface {
    const key = liveKey(kind, sessionId)
    let surface = this.surfaces.get(key)
    if (!surface) {
      surface = {
        sessionId,
        kind,
        active: false,
        url: null,
        title: null,
        app: null,
        startedAt: null,
        lastAt: this.now(),
        frameRev: 0,
        nextActionId: 1,
        feed: [],
      }
      this.surfaces.set(key, surface)
    }
    return surface
  }

  private emit(surface: Surface): void {
    const state = this.snapshot(surface, LIVE_EVENT_FEED_TAIL)
    for (const listener of this.listeners) listener(state)
  }

  private snapshot(surface: Surface, tail = LIVE_FEED_LIMIT): LiveState {
    return {
      sessionId: surface.sessionId,
      kind: surface.kind,
      active: surface.active,
      url: surface.url,
      title: surface.title,
      app: surface.app,
      action: surface.feed.at(-1)?.label ?? null,
      startedAt: surface.startedAt,
      lastAt: surface.lastAt,
      frameRev: surface.frameRev,
      feed: surface.feed.slice(-tail),
    }
  }

  /** The surface is open/running. A fresh opening restarts the clock but keeps the feed. */
  open(kind: LiveKind, sessionId: string, patch: SurfacePatch = {}): void {
    const surface = this.get(kind, sessionId)
    const was = surface.active
    surface.active = true
    if (!was) surface.startedAt = this.now()
    surface.lastAt = this.now()
    Object.assign(surface, patch)
    this.emit(surface)
  }

  /** The panel closed / the control ended. The last feed stays so the phone can still show it. */
  close(kind: LiveKind, sessionId: string): void {
    const surface = this.surfaces.get(liveKey(kind, sessionId))
    if (!surface?.active) return
    surface.active = false
    surface.lastAt = this.now()
    this.emit(surface)
  }

  /** Metadata changed (URL/title/app) without an action. Emits only when something differs. */
  update(kind: LiveKind, sessionId: string, patch: SurfacePatch): void {
    const surface = this.get(kind, sessionId)
    const changed = (Object.keys(patch) as (keyof SurfacePatch)[]).some((k) => surface[k] !== patch[k])
    if (!changed) return
    Object.assign(surface, patch)
    surface.lastAt = this.now()
    this.emit(surface)
  }

  /** An action started. Consecutive duplicates collapse (the agent re-reading the page, a repeating wait). */
  action(kind: LiveKind, sessionId: string, label: string): void {
    const text = label.trim()
    if (!text) return
    const surface = this.get(kind, sessionId)
    if (!surface.active) {
      surface.active = true
      surface.startedAt = this.now()
    }
    surface.lastAt = this.now()
    if (surface.feed.at(-1)?.label !== text) {
      surface.feed.push({ id: surface.nextActionId++, at: surface.lastAt, label: text })
      if (surface.feed.length > LIVE_FEED_LIMIT) surface.feed.splice(0, surface.feed.length - LIVE_FEED_LIMIT)
    }
    this.emit(surface)
  }

  /** A new frame can be fetched. */
  frame(kind: LiveKind, sessionId: string): void {
    const surface = this.get(kind, sessionId)
    surface.frameRev += 1
    surface.lastAt = this.now()
    this.emit(surface)
  }

  state(kind: LiveKind, sessionId: string): LiveState | null {
    const surface = this.surfaces.get(liveKey(kind, sessionId))
    return surface ? this.snapshot(surface) : null
  }

  /** Surfaces that are open now (the phone shows chips only for these). */
  listActive(): LiveState[] {
    return [...this.surfaces.values()].filter((s) => s.active).map((s) => this.snapshot(s))
  }

  /** Forgets a session entirely (chat deleted). */
  forget(sessionId: string): void {
    for (const kind of ['browser', 'computer'] as const) this.surfaces.delete(liveKey(kind, sessionId))
  }
}

/**
 * Per-key trailing throttle for the pushed events: at most one event per `ms` for a surface,
 * always delivering the LAST state (a burst of actions ends with the newest one, not the
 * first). `schedule` is injectable so the test does not need real timers.
 */
export function createLiveThrottle(
  send: (state: LiveState) => void,
  ms = 500,
  schedule: (fn: () => void, ms: number) => unknown = (fn, delay) => setTimeout(fn, delay),
  now: () => number = Date.now,
): (state: LiveState) => void {
  const lastSent = new Map<string, number>()
  const lastActive = new Map<string, boolean>()
  const pending = new Map<string, LiveState>()
  return (state) => {
    const key = liveKey(state.kind, state.sessionId)
    // Open/close flips are never delayed: the chip must appear and vanish promptly.
    const previous = lastSent.get(key)
    const urgent = previous === undefined || lastActive.get(key) !== state.active
    lastActive.set(key, state.active)
    const wait = urgent ? 0 : ms - (now() - (previous ?? 0))
    if (wait <= 0) {
      lastSent.set(key, now())
      pending.delete(key)
      send(state)
      return
    }
    const queued = pending.has(key)
    pending.set(key, state)
    if (queued) return
    schedule(() => {
      const latest = pending.get(key)
      pending.delete(key)
      if (!latest) return
      lastSent.set(key, now())
      send(latest)
    }, wait)
  }
}

/** Fits (width, height) inside `edge` on the longest side, never upscaling. */
export function fitFrameSize(width: number, height: number, edge: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= edge || longest <= 0) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
  const scale = edge / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export interface EncodedFrame {
  dataUrl: string
  width: number
  height: number
  marker: { x: number; y: number; w: number; h: number; label: string } | null
}

export interface LiveDeps {
  registry: LiveRegistry
  /** Newest frame for the surface, already downscaled/encoded; null when there is none. */
  captureFrame: (kind: LiveKind, sessionId: string) => Promise<EncodedFrame | null>
  stop: (kind: LiveKind, sessionId: string) => void
}

export interface LiveResult {
  status: number
  body: unknown
}

export function parseKind(value: unknown): LiveKind | null {
  return value === 'browser' || value === 'computer' ? value : null
}

/** GET /api/live/frame */
export async function liveFrameRequest(
  deps: LiveDeps,
  params: { sessionId?: string | null; kind?: string | null; since?: string | null },
): Promise<LiveResult> {
  const kind = parseKind(params.kind)
  if (!params.sessionId || !kind) return { status: 400, body: { error: 'sessionId and kind (browser|computer) are required' } }
  const state = deps.registry.state(kind, params.sessionId)
  if (!state) return { status: 404, body: { error: 'No live surface for this session' } }
  const unavailable = (reason: LiveFrameUnavailable): LiveResult => ({
    status: 200,
    body: { unavailable: true, reason, rev: state.frameRev, state } satisfies LiveFrameResponse,
  })
  if (!state.active) return unavailable('closed')
  const since = Number(params.since)
  if (Number.isFinite(since) && params.since != null && params.since !== '' && since === state.frameRev && state.frameRev > 0) {
    return { status: 200, body: { unchanged: true, rev: state.frameRev, state } satisfies LiveFrameResponse }
  }
  let frame: EncodedFrame | null = null
  try {
    frame = await deps.captureFrame(kind, params.sessionId)
  } catch {
    return unavailable('capture-failed')
  }
  if (!frame) return unavailable(state.frameRev === 0 ? 'no-frame' : 'capture-failed')
  const fresh = deps.registry.state(kind, params.sessionId) ?? state
  return { status: 200, body: { rev: fresh.frameRev, state: fresh, ...frame } satisfies LiveFrameResponse }
}

/** POST /api/live/stop */
export function liveStopRequest(deps: LiveDeps, body: { sessionId?: unknown; kind?: unknown }): LiveResult {
  const kind = parseKind(body.kind)
  if (typeof body.sessionId !== 'string' || !body.sessionId || !kind) {
    return { status: 400, body: { error: 'sessionId and kind (browser|computer) are required' } }
  }
  const state = deps.registry.state(kind, body.sessionId)
  if (!state?.active) return { status: 200, body: { stopped: false } }
  deps.stop(kind, body.sessionId)
  return { status: 200, body: { stopped: true } }
}

/** GET /api/live */
export function liveListRequest(deps: LiveDeps): LiveResult {
  return { status: 200, body: { sessions: deps.registry.listActive() } }
}
