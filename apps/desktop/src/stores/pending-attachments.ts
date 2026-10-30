import { create } from "zustand"

/**
 * Images attached in the message input (not sent yet). The attachment state
 * lives in the PromptInputProvider, local to each input — the VisionHintCard,
 * rendered outside it, needs to know whether there is a pending image to warn
 * the user BEFORE the send, not after.
 */
interface PendingAttachmentsState {
  /** Key = sessionId (or "draft"/draftKey for a new chat) → there is a pending image */
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
