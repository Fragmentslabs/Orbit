import { create } from 'zustand'
import { Storage } from '~/lib/storage'

/**
 * Folders of code mode that the next chat will use, and the sidebar folder in
 * which it should be born.
 *
 * On the desktop the folders of the picker live in the workspace and are persisted
 * (`orbit-recent-folders`): opening a new chat already comes with the folder of the last
 * work. On the phone they were only a useState of the chat screen, so every
 * new chat started without a folder — and code mode without a folder has nothing to do.
 *
 * `pendingFolderId` is the equivalent of the desktop pendingFolderId: the "+" of the
 * folder in the sidebar takes the new chat inside it when it is created.
 */

const RECENT_FOLDERS_KEY = 'orbit_recent_folders'

interface DraftFoldersState {
  folders: string[]
  pendingFolderId: string | null
  hydrated: boolean
  setFolders: (folders: string[]) => void
  setPendingFolder: (folderId: string | null) => void
  /** Reads the disk the first time; afterwards returns what is already in memory. */
  hydrate: () => Promise<string[]>
}

export const useDraftFolders = create<DraftFoldersState>((set, get) => ({
  folders: [],
  pendingFolderId: null,
  hydrated: false,

  setFolders: (folders) => {
    set({ folders })
    void Storage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(folders))
  },

  setPendingFolder: (folderId) => set({ pendingFolderId: folderId }),

  hydrate: async () => {
    if (get().hydrated) return get().folders
    try {
      const raw = await Storage.getItem(RECENT_FOLDERS_KEY)
      const folders = raw ? (JSON.parse(raw) as string[]) : []
      const valid = Array.isArray(folders) ? folders.filter((f) => typeof f === 'string') : []
      set({ folders: valid, hydrated: true })
      return valid
    } catch {
      set({ hydrated: true })
      return []
    }
  },
}))
