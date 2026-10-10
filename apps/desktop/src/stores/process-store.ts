import { create } from "zustand"
import { processApi } from "@/src/lib/ipc"

import type { ProcessInfo } from "@/src/lib/ipc"

interface ProcessStore {
  processes: ProcessInfo[]
  /**
   * Escopo global: TODOS os processos, de todos os chats, cada um com o seu dono
   * (sessionId). Campo separado de `processes` porque o store é compartilhado —
   * a aba de browser/processo também chama fetch(sessão), e uma lista única seria
   * sobrescrita no meio do poll do rodapé, que é justamente quem pede "todos".
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
   * Os processos de UMA sessão.
   *
   * Sem sessão não existe "todos": quem chama sem escopo quer a lista da própria
   * conversa, e a conversa ainda não existe (chat novo). O main, sem filtro,
   * devolve os processos de TODO mundo — foi assim que o dev server de um chat
   * de código apareceu no rodapé de um chat comum. Quem quer a lista de todos
   * pede pelo nome: fetchAll().
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

  /**
   * TODOS os processos, de todos os chats, sem filtro — é o modo "todos os
   * chats" do rodapé, que marca a origem de cada linha. Pedir a lista sem filtro
   * aqui é intencional: a UI mostra tudo de propósito e diz de quem é cada um.
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