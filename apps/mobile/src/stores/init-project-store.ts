import { create } from 'zustand'
import type { FolderInitStatusResponse } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from '~/stores/connection-store'
import { normalizePath } from '~/lib/known-folders'

/**
 * Per-folder state of the "analyze this project" card: whether /init already ran (asked to the
 * desktop, cached) and the folders the person dismissed (30 days, like the desktop).
 */

const DISMISSED_KEY = 'orbit_init_dismissed'
const DISMISSED_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function pruneDismissed(stored: Record<string, number>, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(stored).filter(([, ts]) => now - ts < DISMISSED_TTL_MS))
}

interface InitProjectState {
  initialized: Record<string, boolean>
  running: Record<string, boolean>
  dismissed: Record<string, number>
  hydrated: boolean
  hydrate: () => Promise<void>
  check: (directory: string) => Promise<void>
  dismiss: (directory: string) => void
}

export const useInitProjectStore = create<InitProjectState>((set, get) => ({
  initialized: {},
  running: {},
  dismissed: {},
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return
    let dismissed: Record<string, number> = {}
    try {
      const raw = await Storage.getItem(DISMISSED_KEY)
      if (raw) dismissed = pruneDismissed(JSON.parse(raw) as Record<string, number>, Date.now())
    } catch {
      dismissed = {}
    }
    set({ dismissed, hydrated: true })
  },

  check: async (directory) => {
    const key = normalizePath(directory)
    if (get().initialized[key] !== undefined && !get().running[key]) return
    try {
      const res = await useConnectionStore.getState().wsClient.send({ type: 'folders:init-status', directory })
      if (!res.ok || !res.data) return
      const status = res.data as FolderInitStatusResponse
      set((s) => ({
        initialized: { ...s.initialized, [key]: status.initialized },
        running: { ...s.running, [key]: status.running },
      }))
    } catch {
      // Unknown stays unknown: the card only shows when the desktop said "not initialized".
    }
  },

  dismiss: (directory) => {
    const dismissed = { ...get().dismissed, [normalizePath(directory)]: Date.now() }
    set({ dismissed })
    void Storage.setItem(DISMISSED_KEY, JSON.stringify(dismissed)).catch(() => {})
  },
}))
