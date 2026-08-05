import { useEffect } from "react"
import { usePromptInputController } from "@/src/components/ai/prompt-input"
import { useDraftInput } from "@/src/stores/draft-input"
import { usePanelStore } from "@/src/stores/panel-store"
import type { FilePart } from "@shared/chat"

/**
 * Anexos persistidos guardam data URL; o input trabalha com File (converte para
 * blob URL no chip e de volta para data URL no submit). Esta é a volta desse
 * caminho, usada quando um revert devolve a mensagem para o input.
 */
async function toFiles(parts: FilePart[]): Promise<File[]> {
  const files = await Promise.all(
    parts.map(async (part) => {
      try {
        const blob = await (await fetch(part.url)).blob()
        return new File([blob], part.filename ?? "anexo", { type: part.mime })
      } catch {
        // Anexo corrompido não pode impedir o texto de voltar ao input
        return null
      }
    }),
  )
  return files.filter((f): f is File => f !== null)
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
      void toFiles(payload.files).then((files) => {
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
