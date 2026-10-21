import { useEffect } from "react"
import { usePromptInputController, type MediaAttachmentRef } from "@/src/components/ai/prompt-input"
import { useDraftInput } from "@/src/stores/draft-input"
import { usePanelStore } from "@/src/stores/panel-store"
import type { FilePart } from "@shared/chat"

/**
 * Anexos persistidos guardam data URL; o input trabalha com File (converte para
 * blob URL no chip e de volta para data URL no submit). Esta é a volta desse
 * caminho, usada quando um revert devolve a mensagem para o input.
 *
 * O anexo que é uma REFERÊNCIA à galeria (`mediaId`) NÃO volta como File: montar
 * um File a partir da URL o faria virar cópia nova no reenvio. Ele volta pelo
 * mesmo caminho do drag da aba Mídia (addMedia), mantendo a referência.
 */
async function restoreAttachments(parts: FilePart[]): Promise<{
  files: File[]
  media: MediaAttachmentRef[]
}> {
  const files: File[] = []
  const media: MediaAttachmentRef[] = []
  await Promise.all(
    parts.map(async (part) => {
      if (part.mediaId) {
        media.push({ id: part.mediaId, name: part.filename, mime: part.mime, url: part.url })
        return
      }
      try {
        const blob = await (await fetch(part.url)).blob()
        files.push(new File([blob], part.filename ?? "anexo", { type: part.mime }))
      } catch {
        // Anexo corrompido não pode impedir o texto de voltar ao input
      }
    }),
  )
  return { files, media }
}

export function DraftInputBridge({ sessionId }: { sessionId?: string }) {
  const controller = usePromptInputController()
  const key = sessionId ?? "draft"
  const draft = useDraftInput((s) => s.drafts[key])
  const pendingInput = usePanelStore((s) => s.pendingInput)

  useEffect(() => {
    if (draft === undefined) return
    const payload = useDraftInput.getState().consume(sessionId)
    if (payload === null) return
    controller.textInput.setInput(payload.text)
    if (payload.files?.length) {
      void restoreAttachments(payload.files).then(({ files, media }) => {
        for (const ref of media) controller.attachments.addMedia(ref)
        if (files.length > 0) controller.attachments.add(files)
      })
    }
  }, [draft, controller.textInput, controller.attachments, sessionId])

  useEffect(() => {
    if (!pendingInput) return
    if (pendingInput.sessionId !== sessionId) return
    controller.textInput.setInput(pendingInput.text)
    usePanelStore.getState().setPendingInput(null)
  }, [pendingInput, controller.textInput, sessionId])

  return null
}
