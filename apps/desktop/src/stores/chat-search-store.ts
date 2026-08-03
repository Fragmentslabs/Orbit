import { create } from "zustand"

/** Estado da busca dentro da conversa ativa — aberta a partir do menu de opções do header. */
interface ChatSearchState {
  open: boolean
  toggle: () => void
  close: () => void
}

export const useChatSearchStore = create<ChatSearchState>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}))
