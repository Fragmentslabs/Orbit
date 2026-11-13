import { create } from 'zustand'
import type {
  GenerationResult,
  NewRoutineInput,
  Routine,
  RoutineEvent,
  RoutineModel,
  RoutineRun,
} from '@orbit/shared'
import { useConnectionStore } from './connection-store'
import { useSessionStore } from './session-store'

/**
 * Routine state in the app (mirror of the desktop's routines-store, but over
 * the WS).
 *
 * The desktop main process owns the truth: every mutation goes through a
 * `routines:*` request and comes back as a `routines:event` — including the
 * ones the scheduler fires on its own (execution starting, finishing,
 * `lastRun` moving). No optimistic execution update.
 *
 * The EXECUTIONS shown in the detail screen are derived from the sessions
 * (`sessions.filter(s => s.routineId === id)`): `runs` keeps only the metrics,
 * keyed by sessionId — deleting the chat in the sidebar makes the run disappear
 * from the list.
 */

interface RoutinesState {
  routines: Routine[]
  runs: RoutineRun[]
  loading: boolean
  loaded: boolean

  /** Loads the full snapshot (routines + runs) over the WS. */
  load: () => Promise<void>
  applyEvent: (event: RoutineEvent) => void

  generate: (
    description: string,
    model: RoutineModel,
    folders: string[],
    language?: string,
    visionAvailable?: boolean,
  ) => Promise<GenerationResult>
  create: (input: NewRoutineInput) => Promise<Routine>
  update: (id: string, patch: Partial<Routine>) => Promise<void>
  /** Removes the routine + the chats of its executions + the metrics. */
  remove: (id: string) => Promise<void>
  runNow: (id: string) => Promise<string | null>
  /** Discards the metrics of executions whose chat no longer exists. */
  prune: (liveSessionIds: string[]) => Promise<void>

  isRunning: (routineId: string) => boolean
}

export const useRoutinesStore = create<RoutinesState>((set, get) => ({
  routines: [],
  runs: [],
  loading: false,
  loaded: false,

  load: async () => {
    const { wsClient } = useConnectionStore.getState()
    set({ loading: true })
    try {
      const res = await wsClient.send({ type: 'routines:list' })
      if (res.ok && res.data) {
        const data = res.data as { routines: Routine[]; runs: RoutineRun[] }
        set({ routines: data.routines, runs: data.runs, loaded: true })
      }
    } catch {
      // WS unavailable — keeps the current state
    } finally {
      set({ loading: false })
    }
  },

  applyEvent: (event) => {
    switch (event.type) {
      case 'routines':
        set({ routines: event.routines })
        break
      case 'routine':
        set((state) => {
          const exists = state.routines.some((r) => r.id === event.routine.id)
          return {
            routines: exists
              ? state.routines.map((r) => (r.id === event.routine.id ? event.routine : r))
              : [...state.routines, event.routine],
          }
        })
        break
      case 'routine-removed':
        set((state) => ({
          routines: state.routines.filter((r) => r.id !== event.id),
          runs: state.runs.filter((r) => r.routineId !== event.id),
        }))
        break
      case 'run':
        set((state) => {
          const exists = state.runs.some((r) => r.sessionId === event.run.sessionId)
          return {
            runs: exists
              ? state.runs.map((r) => (r.sessionId === event.run.sessionId ? event.run : r))
              : [...state.runs, event.run],
          }
        })
        break
    }
  },

  generate: (description, model, folders, language, visionAvailable) => {
    const { wsClient } = useConnectionStore.getState()
    return wsClient
      .send({ type: 'routines:generate', description, model, folders, language, visionAvailable })
      .then((res) => (res.ok && res.data ? (res.data as GenerationResult) : { ok: false, error: res.error ?? 'Failed to generate' }))
  },

  create: async (input) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'routines:create', input })
    if (!res.ok || !res.data) throw new Error(res.error ?? 'Failed to create the routine')
    const routine = res.data as Routine
    set((state) => ({
      routines: state.routines.some((r) => r.id === routine.id) ? state.routines : [...state.routines, routine],
      loaded: true,
    }))
    return routine
  },

  update: async (id, patch) => {
    const { wsClient } = useConnectionStore.getState()
    await wsClient.send({ type: 'routines:update', id, patch })
  },

  remove: async (id) => {
    // Deleting the routine also deletes the chats of its executions. The real
    // cascade (abort the stream, storage) is the session-store's deleteSession —
    // the main process only handles the routine record and the metrics.
    const sessions = useSessionStore
      .getState()
      .sessions.filter((s) => s.routineId === id)
      .map((s) => s.id)
    for (const sessionId of sessions) {
      await useSessionStore.getState().deleteSession(sessionId)
    }
    const { wsClient } = useConnectionStore.getState()
    await wsClient.send({ type: 'routines:delete', id })
    set((state) => ({
      routines: state.routines.filter((r) => r.id !== id),
      runs: state.runs.filter((r) => r.routineId !== id),
    }))
  },

  runNow: async (id) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'routines:run', id })
    if (!res.ok) return null
    return (res.data as string | null) ?? null
  },

  prune: async (liveSessionIds) => {
    const live = new Set(liveSessionIds)
    const orphans = get().runs.filter((r) => r.status !== 'running' && !live.has(r.sessionId))
    if (orphans.length === 0) return
    const { wsClient } = useConnectionStore.getState()
    await wsClient.send({ type: 'routines:prune-runs', sessionIds: liveSessionIds })
    set((state) => ({
      runs: state.runs.filter((r) => r.status === 'running' || live.has(r.sessionId)),
    }))
  },

  isRunning: (routineId) => get().runs.some((r) => r.routineId === routineId && r.status === 'running'),
}))
