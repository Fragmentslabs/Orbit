import { create } from "zustand"
import { processApi } from "@/src/lib/ipc"

import type { ProcessInfo } from "@/src/lib/ipc"

interface ProcessStore {
  processes: ProcessInfo[]
  /**
   * Global scope: ALL processes, from all chats, each with its owner
   * (sessionId). A field separate from `processes` because the store is shared —
   * the browser/process tab also calls fetch(session), and a single list would be
   * overwritten in the middle of the footer's poll, which is exactly who asks for "all".
   */
  allProcesses: ProcessInfo[]
  fetch: (sessionId?: string) => Promise<void>
  fetchAll: () => Promise<void>
  kill: (pid: number, sessionId?: string) => Promise<void>
}

export const useProcessStore = create<ProcessStore>((set, get) => ({
  processes: [],
  allProcesses: [],

  /**
   * The processes of ONE session.
   *
   * Without a session there is no "all": whoever calls without a scope wants the list of their own
   * conversation, and the conversation does not exist yet (new chat). Main, without a filter,
   * returns everyone's processes — that is how a code chat's dev server
   * showed up in the footer of a regular chat. Whoever wants the list of all
   * asks by name: fetchAll().
   */
  fetch: async (sessionId?: string) => {
    if (!sessionId) {
      // Clears what was left from another chat. Conditional on purpose: a set() on
      // every poll (3s) with a new array would re-render the panel for no reason.
      if (get().processes.length > 0) set({ processes: [] })
      return
    }
    const processes = await processApi.list(sessionId)
    set({ processes })
  },

  /**
   * ALL processes, from all chats, without a filter — it is the footer's "all
   * chats" mode, which marks the origin of each row. Asking for the list without a filter
   * here is intentional: the UI shows everything on purpose and says whose each one is.
   */
  fetchAll: async () => {
    const allProcesses = await processApi.list()
    set({ allProcesses })
  },

  kill: async (pid, sessionId) => {
    await processApi.kill(pid, sessionId)
    set((state) => ({
      processes: state.processes.filter((p) => p.pid !== pid),
      allProcesses: state.allProcesses.filter((p) => p.pid !== pid),
    }))
  },
}))