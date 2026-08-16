import { create } from "zustand"
import { storage } from "@/src/lib/ipc"

/**
 * Preferências de notificações nativas do desktop.
 * A chave `notification-prefs` é a MESMA que o main process lê
 * (electron/lib/notifications.ts via readJson) na hora de mostrar o
 * banner — grava por aqui, consome lá.
 */
const STORAGE_KEY = "notification-prefs"

export interface NotificationPrefs {
  /** Desktop faz pergunta/pede permissão */
  pendingAsk: boolean
  /** Nova mensagem do assistente (sessão inativa) */
  newMessage: boolean
  /** Erro no chat */
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
      // Corrompido ou ausente — usa defaults
    }
  },
}))