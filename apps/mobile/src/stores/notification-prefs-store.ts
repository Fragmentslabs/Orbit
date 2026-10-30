import { create } from 'zustand'
import { Storage } from '~/lib/storage'

const STORAGE_KEY = 'orbit_notification_prefs'

export interface NotificationPrefs {
  /** The desktop asks a question/requests permission */
  pendingAsk: boolean
  /** New assistant message (inactive session) */
  newMessage: boolean
  /** Error in the chat */
  chatError: boolean
}

const DEFAULTS: NotificationPrefs = {
  pendingAsk: true,
  newMessage: true,
  chatError: true,
}

interface NotificationPrefsStore {
  prefs: NotificationPrefs
  setPref: <K extends keyof NotificationPrefs>(key: K, value: NotificationPrefs[K]) => Promise<void>
  loadPrefs: () => Promise<void>
}

export const useNotificationPrefsStore = create<NotificationPrefsStore>((set, get) => ({
  prefs: { ...DEFAULTS },

  setPref: async (key, value) => {
    const next = { ...get().prefs, [key]: value }
    set({ prefs: next })
    await Storage.setItem(STORAGE_KEY, JSON.stringify(next))
  },

  loadPrefs: async () => {
    try {
      const raw = await Storage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<NotificationPrefs>
        set({ prefs: { ...DEFAULTS, ...parsed } })
      }
    } catch {
      // Corrupted or missing — uses the defaults
    }
  },
}))
