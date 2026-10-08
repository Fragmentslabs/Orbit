import { create } from "zustand"
import { processApi } from "@/src/lib/ipc"

import type { ProcessInfo } from "@/src/lib/ipc"

interface ProcessStore {
  processes: ProcessInfo[]
  fetch: (sessionId?: string) => Promise<void>
  kill: (pid: number, sessionId?: string) => Promise<void>
}

export const useProcessStore = create<ProcessStore>((set, get) => ({
  processes: [],

  /**
   * Os processos de UMA sessão.
   *
   * Sem sessão não existe "todos": quem chama sem escopo quer a lista da própria
   * conversa, e a conversa ainda não existe (chat novo). O main, sem filtro,
   * devolve os processos de TODO mundo — foi assim que o dev server de um chat
   * de código apareceu no rodapé de um chat comum.
   */
  fetch: async (sessionId?: string) => {
    if (!sessionId) {
      // Limpa o que ficou de outro chat. Condicional de propósito: um set() a
      // cada poll (3s) com um array novo re-renderizaria o painel sem motivo.
      if (get().processes.length > 0) set({ processes: [] })
      return
    }
    const processes = await processApi.list(sessionId)
    set({ processes })
  },

  kill: async (pid, sessionId) => {
    await processApi.kill(pid, sessionId)
    set((state) => ({
      processes: state.processes.filter((p) => p.pid !== pid),
    }))
  },
}))
