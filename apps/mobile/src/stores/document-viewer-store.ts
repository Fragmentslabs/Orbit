import { create } from 'zustand'
import type { SourceRef } from '~/lib/document-source'

/**
 * The open document viewer — one for the whole app, like the memory sheet: the document card and
 * the `#orbit-source` citation (drawn inside a <Text> of the markdown, where a Modal cannot be
 * mounted) only say WHAT to open, and the host mounted in the layout draws it.
 */
export type DocumentTarget =
  /** A document the agent wrote: its HTML preview, already signed by the desktop. */
  | { kind: 'part'; title: string; src: string; sourceSrc?: string; documentId: string; revision?: number }
  /** A conversation source cited in the answer (`docN`/`srcN`), at page and lines. */
  | ({ kind: 'source'; sessionId?: string } & SourceRef)

interface DocumentViewerState {
  target: DocumentTarget | null
  open: (target: DocumentTarget) => void
  close: () => void
}

export const useDocumentViewerStore = create<DocumentViewerState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}))
