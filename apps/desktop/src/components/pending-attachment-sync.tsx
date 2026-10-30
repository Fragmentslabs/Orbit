import { useEffect } from "react"
import { usePromptInputAttachments } from "@/src/components/ai/prompt-input"
import { usePendingAttachmentsStore } from "@/src/stores/pending-attachments"

/**
 * Syncs the input attachments (local state of the PromptInputProvider) with the
 * pending images store — the VisionHintCard, outside the provider, needs
 * to know there is an image attached as soon as it is pasted/added, before
 * the message is sent.
 */
export function PendingAttachmentSync({ sessionId, draftKey }: { sessionId?: string; draftKey?: string }) {
  const files = usePromptInputAttachments().files
  const setPendingImages = usePendingAttachmentsStore((s) => s.setPendingImages)
  const key = sessionId ?? draftKey ?? "draft"
  const hasImage = files.some((f) => f.mediaType?.startsWith("image/"))

  useEffect(() => {
    setPendingImages(key, hasImage)
    return () => setPendingImages(key, false)
  }, [key, hasImage, setPendingImages])

  return null
}
