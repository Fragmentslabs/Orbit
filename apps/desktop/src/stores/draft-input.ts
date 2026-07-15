import { create } from "zustand"

/**
 * Texto pré-preenchido para o próximo input de chat: usado pelo fluxo
 * "Pedir para o Orbit criar" (settings → novo chat com "/create-skill ").
 * O DraftInputBridge dentro do PromptInputProvider consome e limpa.
 */

interface DraftInputState {
  text: string | null
  setDraft: (text: string) => void
  consume: () => string | null
}

export const useDraftInput = create<DraftInputState>((set, get) => ({
  text: null,
  setDraft: (text) => set({ text }),
  consume: () => {
    const { text } = get()
    if (text !== null) set({ text: null })
    return text
  },
}))
