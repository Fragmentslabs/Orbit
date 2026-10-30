import { create } from 'zustand'

/** State of the search inside the active conversation — opened from the options menu of the header. */
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
