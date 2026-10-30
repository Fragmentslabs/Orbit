import { create } from "zustand"
import { storage } from "@/src/lib/ipc"

/**
 * Preferences of the desktop's native notifications.
 * The `notification-prefs` key is the SAME one the main process reads
 * (electron/lib/notifications.ts via readJson) when showing the
 * banner — write it here, consume it there.
 */
const STORAGE_KEY = "notification-prefs"

export interface NotificationPrefs {
  /** Desktop asks a question/requests permission */
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
    await storage.write(STORAGE_KEY, next)
  },

  loadPrefs: async () => {
    try {
      const saved = await storage.read<Partial<NotificationPrefs>>(STORAGE_KEY)
      if (saved) set({ prefs: { ...DEFAULTS, ...saved } })
    } catch {
      // Corrupted or absent — uses defaults
    }
  },
}))