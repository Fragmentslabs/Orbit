import { create } from 'zustand'
import type { PermissionMode } from '@orbit/shared'
import { Storage } from '~/lib/storage'

/**
 * Modo de permissão do modo código — global, como no desktop. Vive fora do
 * PromptInput porque o card de revisão de plano também precisa dele: o aceite
 * padrão tem que sugerir o modo que está selecionado agora.
 */

const STORAGE_KEY = 'orbit-permission-mode'

interface PermissionPrefsState {
  mode: PermissionMode
  hydrated: boolean
  hydrate: () => Promise<void>
  setMode: (mode: PermissionMode) => void
}

export const usePermissionPrefs = create<PermissionPrefsState>((set) => ({
  mode: 'ask',
  hydrated: false,

  hydrate: async () => {
    try {
      const stored = await Storage.getItem(STORAGE_KEY)
      if (stored === 'approve' || stored === 'full' || stored === 'ask') {
        set({ mode: stored, hydrated: true })
        return
      }
    } catch {
      // preferência ilegível — segue no padrão mais conservador (ask)
    }
    set({ hydrated: true })
  },

  setMode: (mode) => {
    void Storage.setItem(STORAGE_KEY, mode)
    set({ mode })
  },
}))
