import { create } from "zustand"

export interface TerminalEntry {
  id: string
  ptyId: string
  cwd: string
  createdAt: number
}

interface TerminalStore {
  entries: Record<string, TerminalEntry>

  createTerminal: (tabId: string, cwd?: string) => Promise<string>
  killTerminal: (tabId: string) => Promise<void>
  killAll: () => Promise<void>
  getTerminal: (tabId: string) => TerminalEntry | undefined
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  entries: {},

  createTerminal: async (tabId, cwd) => {
    const ptyId = crypto.randomUUID()
    await window.ipcRenderer.invoke("terminal:create", ptyId, undefined, undefined, cwd)
    const entry: TerminalEntry = {
      id: tabId,
      ptyId,
      cwd: cwd ?? "",
      createdAt: Date.now(),
    }
    set((state) => ({
      entries: { ...state.entries, [tabId]: entry },
    }))
    return ptyId
  },

  killTerminal: async (tabId) => {
    const entry = get().entries[tabId]
    if (!entry) return
    await window.ipcRenderer.invoke("terminal:kill", entry.ptyId)
    set((state) => {
      const next = { ...state.entries }
      delete next[tabId]
      return { entries: next }
    })
  },

  killAll: async () => {
    const { entries } = get()
    const kills = Object.values(entries).map((e) =>
      window.ipcRenderer.invoke("terminal:kill", e.ptyId).catch(() => {}),
    )
    await Promise.all(kills)
    set({ entries: {} })
  },

  getTerminal: (tabId) => {
    return get().entries[tabId]
  },
}))
