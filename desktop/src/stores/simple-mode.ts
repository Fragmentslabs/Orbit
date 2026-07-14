import { create } from "zustand"

/**
 * Toggle global do modo simples, persistido em localStorage. Fica em um store
 * (e não no estado local do input) porque o ChatView também precisa dele para
 * ocultar a persona enquanto o modo está ativo.
 */

const STORAGE_KEY = "orbit-simple-mode"

interface SimpleModeState {
  simple: boolean
  setSimple: (value: boolean) => void
}

export const useSimpleMode = create<SimpleModeState>((set) => ({
  simple: localStorage.getItem(STORAGE_KEY) === "1",
  setSimple: (value) => {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0")
    set({ simple: value })
  },
}))
