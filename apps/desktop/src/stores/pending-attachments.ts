import { create } from "zustand"

/**
 * Imagens anexadas no input de mensagens (ainda não enviadas). O estado dos
 * anexos vive no PromptInputProvider, local a cada input — o VisionHintCard,
 * renderizado fora dele, precisa saber se há uma imagem pendente para avisar
 * o usuário ANTES do envio, não depois.
 */
interface PendingAttachmentsState {
  /** Chave = sessionId (ou "draft"/draftKey para chat novo) → tem imagem pendente */
  imagesByKey: Record<string, boolean>
  setPendingImages: (key: string, hasImage: boolean) => void
}

export const usePendingAttachmentsStore = create<PendingAttachmentsState>((set) => ({
  imagesByKey: {},
  setPendingImages: (key, hasImage) =>
    set((s) => {
      if (s.imagesByKey[key] === hasImage) return s
      return { imagesByKey: { ...s.imagesByKey, [key]: hasImage } }
    }),
}))
