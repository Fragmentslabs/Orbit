import { create } from "zustand"
import type { PendingRoutine } from "@shared/routines"
import { routinesApi } from "@/src/lib/ipc"
import { useRoutinesStore } from "@/src/stores/routines-store"

/**
 * Agent routine proposals (tool routines_manage) waiting for approval in the
 * conversation card — a mirror of the skills-store. "discarded" keeps the ids
 * the person actually refused (localStorage): absence from "pending" is never
 * treated as a refusal. The "created" state comes from the routine with the
 * SAME id in the routines-store (the proposal id is the approved routine id).
 */

const DISCARDED_KEY = "orbit_routine_proposals_discarded"

interface RoutineProposalsState {
  pending: PendingRoutine[]
  discarded: string[]
  load: () => Promise<void>
  approve: (id: string) => Promise<void>
  discard: (id: string) => Promise<void>
}

function loadDiscarded(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISCARDED_KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

export const useRoutineProposalsStore = create<RoutineProposalsState>((set, get) => ({
  pending: [],
  discarded: loadDiscarded(),

  load: async () => {
    set({ pending: await routinesApi.pending() })
  },

  approve: async (id) => {
    const routine = await routinesApi.approvePending(id)
    set((s) => ({
      pending: s.pending.filter((p) => p.id !== id),
      discarded: s.discarded.filter((d) => d !== id),
    }))
    localStorage.setItem(DISCARDED_KEY, JSON.stringify(get().discarded))
    if (routine) {
      // Syncs the routines-store without depending on the 'routine' event — it
      // is what turns the card into "created" right away, even if the event
      // already arrived.
      await useRoutinesStore.getState().load()
    }
  },

  discard: async (id) => {
    await routinesApi.discardPending(id)
    set((s) => ({ discarded: [...new Set([...s.discarded, id])] }))
    localStorage.setItem(DISCARDED_KEY, JSON.stringify(get().discarded))
    await get().load()
  },
}))
