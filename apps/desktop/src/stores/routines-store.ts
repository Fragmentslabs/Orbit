import { create } from "zustand"
import type {
  GenerationResult,
  NewRoutineInput,
  Routine,
  RoutineEvent,
  RoutineModel,
  RoutineRun,
} from "@shared/routines"
import { DEFAULT_ROUTINES, LEGACY_DEFAULT_ROUTINE_IDS } from "@shared/routines-default"
import { routinesApi } from "@/src/lib/ipc"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Routine state in the renderer.
 *
 * The main process owns the truth: every mutation goes through IPC and comes
 * back as `routines:event` — including the ones the scheduler fires on its own
 * (execution starting, finishing, `lastRun` moving). Like the pipeline-store,
 * there is no optimistic execution update.
 *
 * The EXECUTIONS shown in the panel are derived from the sessions
 * (`sessions.filter(s => s.routineId === id)`): `runs` keeps only the metrics,
 * keyed by sessionId. A single source of truth — deleting the chat in the
 * sidebar makes the run disappear from the list with no "deleted" state left
 * hanging.
 */

interface RoutinesState {
  routines: Routine[]
  runs: RoutineRun[]
  loaded: boolean
  /** Routine open in the detail panel (null = list) */
  openId: string | null
  setOpen: (id: string | null) => void

  load: () => Promise<void>
  applyEvent: (event: RoutineEvent) => void

  generate: (
    description: string,
    model: RoutineModel,
    folders: string[],
    language?: string,
    mode?: "chat" | "code",
    visionAvailable?: boolean,
  ) => Promise<GenerationResult>
  create: (input: NewRoutineInput) => Promise<Routine>
  update: (id: string, patch: Partial<Routine>) => Promise<void>
  remove: (id: string) => Promise<void>
  runNow: (id: string) => Promise<string | null>
  /** Fresh chat for a routine that keeps one; archives the current one. Returns the new session id. */
  rotateChat: (id: string) => Promise<string | null>
  /** Discards metrics of executions whose chat no longer exists. */
  prune: (liveSessionIds: string[]) => Promise<void>

  runsOf: (routineId: string) => RoutineRun[]
  runOfSession: (sessionId: string) => RoutineRun | undefined
  isRunning: (routineId: string) => boolean
}

/** STABLE empty array: `?? []` in a zustand selector turns into a render loop. */
export const EMPTY_RUNS: RoutineRun[] = []

/** Presets already seeded — by id, so the user can delete them without them coming back. */
const SEEDED_KEY = "orbit-routines-defaults-seeded"

function seeded(): string[] {
  try {
    const raw = localStorage.getItem(SEEDED_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

/**
 * Creates the maintenance routines that ship with the product, DISABLED.
 *
 * It only runs once a model is selected: `Routine.model` is required, and
 * seeding with an invented model would leave a routine that breaks on first
 * use. With no model, it tries again on the next load.
 *
 * The record of what has been seeded is by id and lives in localStorage:
 * whoever deletes a preset does not see it come back on the next boot.
 */
async function seedDefaultRoutines(): Promise<void> {
  const done = new Set(seeded().map((id) => LEGACY_DEFAULT_ROUTINE_IDS[id] ?? id))
  const pending = DEFAULT_ROUTINES.filter((r) => !done.has(r.id))
  if (pending.length === 0) return

  const model = useProviderStore.getState().selectedModel
  if (!model) return

  for (const preset of pending) {
    try {
      await useRoutinesStore.getState().create({
        title: preset.title,
        prompt: preset.prompt,
        schedule: preset.schedule,
        model: { providerId: model.providerId, modelId: model.modelId },
        modes: preset.modes,
        mode: preset.mode,
        // Both presets are chat mode and do not read files — no folders.
        folders: [],
        active: false,
      })
      done.add(preset.id)
    } catch (err) {
      // A failed seeding can never take the routines screen down.
      console.error("[routines] preset could not be created:", preset.id, err)
    }
  }
  localStorage.setItem(SEEDED_KEY, JSON.stringify([...done]))
}

export const useRoutinesStore = create<RoutinesState>((set, get) => ({
  routines: [],
  runs: [],
  loaded: false,
  openId: null,
  setOpen: (id) => set({ openId: id }),

  load: async () => {
    const data = await routinesApi.load()
    set({ routines: data.routines, runs: data.runs, loaded: true })
    await seedDefaultRoutines()
  },

  applyEvent: (event) => {
    switch (event.type) {
      case "routines":
        set({ routines: event.routines })
        break
      case "routine":
        set((state) => {
          const exists = state.routines.some((r) => r.id === event.routine.id)
          return {
            routines: exists
              ? state.routines.map((r) => (r.id === event.routine.id ? event.routine : r))
              : [...state.routines, event.routine],
          }
        })
        break
      case "routine-removed":
        set((state) => ({
          routines: state.routines.filter((r) => r.id !== event.id),
          runs: state.runs.filter((r) => r.routineId !== event.id),
          openId: state.openId === event.id ? null : state.openId,
        }))
        break
      case "run":
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

  generate: (description, model, folders, language, mode, visionAvailable) =>
    routinesApi.generate(description, model, folders, language, mode, visionAvailable),

  create: async (input) => {
    const routine = await routinesApi.create(input)
    set((state) => ({
      routines: state.routines.some((r) => r.id === routine.id)
        ? state.routines
        : [...state.routines, routine],
    }))
    return routine
  },

  update: async (id, patch) => {
    await routinesApi.update(id, patch)
  },

  remove: async (id) => {
    // Deleting the routine also deletes the chats of its executions. The real
    // cascade (abort stream, storage, prefs, panel browser) is the
    // session-store's deleteSession — the main process only handles the routine
    // record and the metrics.
    const sessions = useSessionStore
      .getState()
      .sessions.filter((s) => s.routineId === id)
      .map((s) => s.id)
    for (const sessionId of sessions) {
      await useSessionStore.getState().deleteSession(sessionId)
    }
    await routinesApi.remove(id)
    set((state) => ({
      routines: state.routines.filter((r) => r.id !== id),
      runs: state.runs.filter((r) => r.routineId !== id),
      openId: state.openId === id ? null : state.openId,
    }))
  },

  runNow: (id) => routinesApi.runNow(id),

  rotateChat: (id) => routinesApi.rotateChat(id),

  prune: async (liveSessionIds) => {
    const live = new Set(liveSessionIds)
    const orphans = get().runs.filter((r) => r.status !== "running" && !live.has(r.sessionId))
    if (orphans.length === 0) return
    await routinesApi.pruneRuns(liveSessionIds)
    set((state) => ({
      runs: state.runs.filter((r) => r.status === "running" || live.has(r.sessionId)),
    }))
  },

  runsOf: (routineId) => get().runs.filter((r) => r.routineId === routineId),
  runOfSession: (sessionId) => get().runs.find((r) => r.sessionId === sessionId),
  isRunning: (routineId) => get().runs.some((r) => r.routineId === routineId && r.status === "running"),
}))
