import { create } from 'zustand'
import type { FragmentCapability, FragmentPhoneEntry } from '@orbit/shared'
import { fragmentsGrant, fragmentsList, fragmentsPin, fragmentsRemove } from '~/lib/fragments-api'

/**
 * The fragments of the desktop, as the phone lists them. The desktop is the source of truth: it
 * pushes WS `fragments:changed` when one is written, renamed, pinned or removed, and `refresh()`
 * reads the list again (a revision that moved is what reloads an open fragment).
 */
interface FragmentsState {
  entries: FragmentPhoneEntry[]
  loaded: boolean
  error: string | null
  refresh: () => Promise<void>
  /** Fixes it at the top of the list, or lets it go (the desktop keeps the flag, so both lists agree). */
  setPinned: (id: string, pinned: boolean) => Promise<void>
  /** Deletes it on the desktop. False when that failed. */
  remove: (id: string) => Promise<boolean>
  /** Allow (or stop allowing) a capability. False when the desktop refused (an unreviewed import). */
  grant: (id: string, capability: FragmentCapability, on: boolean) => Promise<boolean>
  /** How many times a page asked again for something not allowed, per fragment: a counter, so every ask arrives. */
  asks: Record<string, number>
  noteAsk: (id: string) => void
}

export const useFragmentsStore = create<FragmentsState>((set, get) => ({
  entries: [],
  asks: {},
  loaded: false,
  error: null,

  refresh: async () => {
    const res = await fragmentsList()
    if (res.ok) set({ entries: res.data, loaded: true, error: null })
    else set({ loaded: true, error: res.error })
  },

  setPinned: async (id, pinned) => {
    const before = get().entries
    // Optimistic: the list answers at once, and the desktop's own announcement settles it.
    set({ entries: before.map((e) => (e.id === id ? { ...e, pinned } : e)) })
    if (!(await fragmentsPin(id, pinned))) set({ entries: before })
  },

  remove: async (id) => {
    const ok = await fragmentsRemove(id)
    // The desktop announces it too; this just answers at once.
    if (ok) set({ entries: get().entries.filter((e) => e.id !== id) })
    return ok
  },

  grant: async (id, capability, on) => {
    const grants = await fragmentsGrant(id, capability, on)
    if (!grants) return false
    set({ entries: get().entries.map((e) => (e.id === id ? { ...e, grants } : e)) })
    return true
  },

  noteAsk: (id) => set({ asks: { ...get().asks, [id]: (get().asks[id] ?? 0) + 1 } }),
}))
