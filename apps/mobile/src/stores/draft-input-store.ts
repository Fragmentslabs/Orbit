import { create } from 'zustand'

const DRAFT_KEY = 'draft'

interface DraftInputState {
  drafts: Record<string, string>
  setDraft: (sessionId: string | null | undefined, text: string) => void
  consume: (sessionId: string | null | undefined) => string | null
  adopt: (sessionId: string) => void
}

export const useDraftInput = create<DraftInputState>((set, get) => ({
  drafts: {},
  setDraft: (sessionId, text) => {
    const key = sessionId ?? DRAFT_KEY
    set((s) => ({ drafts: { ...s.drafts, [key]: text } }))
  },
  consume: (sessionId) => {
    const key = sessionId ?? DRAFT_KEY
    const { drafts } = get()
    const text = drafts[key] ?? null
    if (text !== null) {
      const next = { ...drafts }
      delete next[key]
      set({ drafts: next })
    }
    return text
  },
  adopt: (sessionId) => {
    const { drafts } = get()
    if (drafts[DRAFT_KEY] === undefined) return
    const next = { ...drafts }
    next[sessionId] = next[DRAFT_KEY]
    delete next[DRAFT_KEY]
    set({ drafts: next })
  },
}))
