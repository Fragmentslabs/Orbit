import { create } from 'zustand'
import type { LiveFrameUnavailable, LiveKind, LiveState } from '@orbit/shared'
import { mergeLiveState, surfaceKey } from '~/lib/live-logic'
import { useConnectionStore } from './connection-store'

/**
 * Live view of the desktop's browser/computer panels.
 *
 * The desktop pushes small `live:event` states (chip, action feed, "a new frame exists") and the
 * heavy part — one downscaled JPEG — is pulled here over HTTP, only by the open live screen and
 * only when the revision moved. A pull while another is in flight is dropped, so a slow link
 * skips frames instead of queueing them.
 */

export interface LiveFrame {
  rev: number
  dataUrl: string
  width: number
  height: number
  marker: { x: number; y: number; w: number; h: number; label: string } | null
}

export type LiveFrameStatus = 'idle' | 'ok' | 'error' | LiveFrameUnavailable

interface LiveStoreState {
  states: Record<string, LiveState>
  frames: Record<string, LiveFrame>
  /** Why there is no (new) frame — drives the empty/closed states of the screen. */
  status: Record<string, LiveFrameStatus>
  /** Consecutive failed pulls per surface — feeds the poll backoff. */
  failures: Record<string, number>

  applyEvent: (state: LiveState) => void
  hydrate: () => Promise<void>
  /** Returns false when the pull failed (network), true otherwise (including "unchanged"). */
  fetchFrame: (sessionId: string, kind: LiveKind) => Promise<boolean>
  stop: (sessionId: string, kind: LiveKind) => Promise<boolean>
  reset: () => void
}

const inFlight = new Set<string>()

export const useLiveStore = create<LiveStoreState>((set, get) => ({
  states: {},
  frames: {},
  status: {},
  failures: {},

  applyEvent: (state) => {
    const key = surfaceKey(state.kind, state.sessionId)
    set((s) => {
      const states = { ...s.states, [key]: mergeLiveState(s.states[key], state) }
      // A closed surface drops its (large) frame; the feed stays readable.
      if (!state.active && s.frames[key]) {
        const { [key]: _gone, ...frames } = s.frames
        return { states, frames, status: { ...s.status, [key]: 'closed' } }
      }
      return { states }
    })
  },

  hydrate: async () => {
    const http = useConnectionStore.getState().http
    if (!http) return
    const res = await http.liveList()
    if (!res.ok || !res.data) return
    const active = new Map(res.data.sessions.map((st) => [surfaceKey(st.kind, st.sessionId), st]))
    set((s) => {
      const states: Record<string, LiveState> = {}
      // Surfaces we knew but the desktop no longer lists (it restarted, the panel closed while we were away).
      for (const [key, st] of Object.entries(s.states)) states[key] = active.has(key) ? st : { ...st, active: false }
      for (const [key, st] of active) states[key] = mergeLiveState(states[key], st)
      return { states }
    })
  },

  fetchFrame: async (sessionId, kind) => {
    const key = surfaceKey(kind, sessionId)
    if (inFlight.has(key)) return true
    const http = useConnectionStore.getState().http
    if (!http) return false
    inFlight.add(key)
    try {
      const res = await http.liveFrame(sessionId, kind, get().frames[key]?.rev)
      if (!res.ok || !res.data) {
        set((s) => ({ failures: { ...s.failures, [key]: (s.failures[key] ?? 0) + 1 }, status: { ...s.status, [key]: 'error' } }))
        return false
      }
      const data = res.data
      const state = mergeLiveState(get().states[key], data.state)
      if ('unavailable' in data && data.unavailable) {
        set((s) => ({ states: { ...s.states, [key]: state }, failures: { ...s.failures, [key]: 0 }, status: { ...s.status, [key]: data.reason } }))
        return true
      }
      if ('unchanged' in data && data.unchanged) {
        set((s) => ({ states: { ...s.states, [key]: state }, failures: { ...s.failures, [key]: 0 }, status: { ...s.status, [key]: 'ok' } }))
        return true
      }
      const frame = data as Extract<typeof data, { dataUrl: string }>
      set((s) => ({
        states: { ...s.states, [key]: state },
        frames: { ...s.frames, [key]: { rev: frame.rev, dataUrl: frame.dataUrl, width: frame.width, height: frame.height, marker: frame.marker } },
        failures: { ...s.failures, [key]: 0 },
        status: { ...s.status, [key]: 'ok' },
      }))
      return true
    } catch {
      set((s) => ({ failures: { ...s.failures, [key]: (s.failures[key] ?? 0) + 1 }, status: { ...s.status, [key]: 'error' } }))
      return false
    } finally {
      inFlight.delete(key)
    }
  },

  stop: async (sessionId, kind) => {
    const http = useConnectionStore.getState().http
    if (!http) return false
    const res = await http.liveStop(sessionId, kind)
    return Boolean(res.ok && res.data?.stopped)
  },

  reset: () => {
    inFlight.clear()
    set({ states: {}, frames: {}, status: {}, failures: {} })
  },
}))

/** Active live surfaces of one chat (browser and/or computer) — for the chip. */
export function selectActiveSurfaces(states: Record<string, LiveState>, sessionId: string | undefined): LiveState[] {
  if (!sessionId) return []
  return (['computer', 'browser'] as const)
    .map((kind) => states[surfaceKey(kind, sessionId)])
    .filter((st): st is LiveState => Boolean(st?.active))
}
