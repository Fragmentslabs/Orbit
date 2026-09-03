import { create } from 'zustand'
import { Storage } from '~/lib/storage'

/**
 * Pastas do modo código que o próximo chat vai usar, e a pasta da sidebar em
 * que ele deve nascer.
 *
 * No desktop as pastas do seletor vivem no workspace e são persistidas
 * (`orbit-recent-folders`): abrir um chat novo já vem com a pasta do último
 * trabalho. No celular elas eram só um useState da tela de chat, então todo
 * chat novo começava sem pasta — e o modo código sem pasta não tem o que fazer.
 *
 * `pendingFolderId` é o equivalente do pendingFolderId do desktop: o "+" da
 * pasta na sidebar leva o chat novo para dentro dela quando ele for criado.
 */

const RECENT_FOLDERS_KEY = 'orbit_recent_folders'

interface DraftFoldersState {
  folders: string[]
  pendingFolderId: string | null
  hydrated: boolean
  setFolders: (folders: string[]) => void
  setPendingFolder: (folderId: string | null) => void
  /** Lê o disco na primeira vez; depois devolve o que já está em memória. */
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
