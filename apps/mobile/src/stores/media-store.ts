import { create } from 'zustand'
import type { MediaEntry, MediaUsage } from '@orbit/shared'
import { useConnectionStore } from './connection-store'

/**
 * Media registry on the desktop (orbit-data/media) read over HTTP from the companion.
 *
 * The mobile gallery has no access to the desktop filesystem — the entries
 * come from the /api/media endpoint with a `url` already signed (token in the query) ready for
 * the native <Image>. The scope per mode (chat vs code) is applied on the screen,
 * using the local sessions, just like the desktop.
 */

interface MediaState {
  entries: MediaEntry[]
  usage: MediaUsage
  loading: boolean
  refreshing: boolean

  /** Fetches the list and the usage of the registry on the desktop. */
  refresh: () => Promise<void>
  /** Removes several images (batch selection) and reloads. */
  remove: (ids: string[]) => Promise<void>
  /** Removes one image and reloads. */
  removeOne: (id: string) => Promise<void>
}

export const useMediaStore = create<MediaState>((set, get) => ({
  entries: [],
  usage: { count: 0, bytes: 0 },
  loading: true,
  refreshing: false,

  refresh: async () => {
    const http = useConnectionStore.getState().http
    if (!http) {
      set({ loading: false, refreshing: false })
      return
    }
    const hasData = get().entries.length > 0
    if (hasData) set({ refreshing: true })
    else set({ loading: true })

    try {
      const [list, usage] = await Promise.all([http.listMedia(), http.mediaUsage()])
      set({
        entries: list.ok && Array.isArray(list.data) ? list.data : get().entries,
        usage: usage.ok && usage.data ? usage.data : get().usage,
      })
    } catch {
      // best effort — keeps what was already on screen
    } finally {
      set({ loading: false, refreshing: false })
    }
  },

  remove: async (ids) => {
    const http = useConnectionStore.getState().http
    if (!http || ids.length === 0) return
    await http.deleteManyMedia(ids)
    await get().refresh()
  },

  removeOne: async (id) => {
    const http = useConnectionStore.getState().http
    if (!http) return
    await http.deleteMedia(id)
    await get().refresh()
  },
}))
