import { create } from 'zustand'

/** State of the search inside the active conversation — opened from the options menu of the header. */
interface ChatSearchState {
  open: boolean
  /** Message holding the current result and the term to paint inside it. */
  activeMessageId: string | null
  term: string
  toggle: () => void
  close: () => void
  setActive: (messageId: string | null, term: string) => void
}

export const useChatSearchStore = create<ChatSearchState>((set) => ({
  open: false,
  activeMessageId: null,
  term: '',
  toggle: () => set((s) => (s.open ? { open: false, activeMessageId: null, term: '' } : { open: true })),
  close: () => set({ open: false, activeMessageId: null, term: '' }),
  setActive: (activeMessageId, term) => set({ activeMessageId, term }),
}))
