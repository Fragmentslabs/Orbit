import { create } from "zustand"
import type { RotinaPendente } from "@shared/rotinas"
import { rotinasApi } from "@/src/lib/ipc"
import { useRotinasStore } from "@/src/stores/rotinas-store"

/**
 * Propostas de rotina do agente (tool rotinas_manage) aguardando aprovação no
 * card da conversa — espelho do skills-store. "descartadas" guarda os ids que
 * a pessoa realmente recusou (localStorage): a ausência em "pendentes" nunca
 * é tratada como recusa. O estado "criada" vem da rotina de MESMO id no
 * rotinas-store (o id da proposta é o id da rotina aprovada).
 */

const DESCARTADAS_KEY = "orbit_rotina_propostas_descartadas"

interface RotinasPropostasState {
  pendentes: RotinaPendente[]
  descartadas: string[]
  carregar: () => Promise<void>
  aprovar: (id: string) => Promise<void>
  descartar: (id: string) => Promise<void>
}

function carregarDescartadas(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DESCARTADAS_KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

export const useRotinasPropostasStore = create<RotinasPropostasState>((set, get) => ({
  pendentes: [],
  descartadas: carregarDescartadas(),

  carregar: async () => {
    set({ pendentes: await rotinasApi.pendentes() })
  },

  aprovar: async (id) => {
    const rotina = await rotinasApi.aprovarPendente(id)
    set((s) => ({
      pendentes: s.pendentes.filter((p) => p.id !== id),
      descartadas: s.descartadas.filter((d) => d !== id),
    }))
    localStorage.setItem(DESCARTADAS_KEY, JSON.stringify(get().descartadas))
    if (rotina) {
      // Sincroniza o rotinas-store sem depender do evento 'rotina' — é o que
      // faz o card virar "criada" na hora, mesmo se o evento já veio.
      await useRotinasStore.getState().carregar()
    }
  },

  descartar: async (id) => {
    await rotinasApi.descartarPendente(id)
    set((s) => ({ descartadas: [...new Set([...s.descartadas, id])] }))
    localStorage.setItem(DESCARTADAS_KEY, JSON.stringify(get().descartadas))
    await get().carregar()
  },
}))
