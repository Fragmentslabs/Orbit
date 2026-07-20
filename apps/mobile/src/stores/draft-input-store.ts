import { create } from 'zustand'

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
