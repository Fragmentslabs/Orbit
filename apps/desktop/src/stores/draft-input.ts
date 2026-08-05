import { create } from "zustand"
import type { FilePart } from "@shared/chat"

const DRAFT_KEY = "draft"

export interface DraftPayload {
  text: string
  /** Anexos devolvidos ao input junto com o texto (ex: revert de uma
   *  mensagem que tinha imagem — sem isso o anexo sumiria silenciosamente). */
  files?: FilePart[]
}

interface DraftInputState {
  drafts: Record<string, DraftPayload>
  setDraft: (sessionId: string | null | undefined, text: string, files?: FilePart[]) => void
  consume: (sessionId: string | null | undefined) => DraftPayload | null
  adopt: (sessionId: string) => void
}

export const useDraftInput = create<DraftInputState>((set, get) => ({
  drafts: {},
  setDraft: (sessionId, text, files) => {
    const key = sessionId ?? DRAFT_KEY
    set((s) => ({ drafts: { ...s.drafts, [key]: { text, files } } }))
  },
  consume: (sessionId) => {
    const key = sessionId ?? DRAFT_KEY
    const { drafts } = get()
    const payload = drafts[key] ?? null
    if (payload !== null) {
      const next = { ...drafts }
      delete next[key]
      set({ drafts: next })
    }
    return payload
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
