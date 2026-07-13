import { create } from "zustand"
import { processApi } from "@/src/lib/ipc"

import type { ProcessInfo } from "@/src/lib/ipc"

interface ProcessStore {
  processes: ProcessInfo[]
  fetch: () => Promise<void>
  kill: (pid: number) => Promise<void>
}

export const useProcessStore = create<ProcessStore>((set) => ({
  processes: [],

  fetch: async () => {
    const processes = await processApi.list()
    set({ processes })
  },

  kill: async (pid) => {
    await processApi.kill(pid)
    set((state) => ({
      processes: state.processes.filter((p) => p.pid !== pid),
    }))
  },
}))
