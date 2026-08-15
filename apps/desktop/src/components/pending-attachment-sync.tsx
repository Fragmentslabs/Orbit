import { useEffect } from "react"
import { usePromptInputAttachments } from "@/src/components/ai/prompt-input"
import { usePendingAttachmentsStore } from "@/src/stores/pending-attachments"

/**
 * Sincroniza os anexos do input (estado local do PromptInputProvider) com a
 * store de imagens pendentes — o VisionHintCard, fora do provider, precisa
 * saber que há uma imagem anexada assim que ela é colada/adicionada, antes
 * de a mensagem ser enviada.
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
