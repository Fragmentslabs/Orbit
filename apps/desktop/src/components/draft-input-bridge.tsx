import { useEffect } from "react"
import { usePromptInputController } from "@/src/components/ai/prompt-input"
import { useDraftInput } from "@/src/stores/draft-input"
import { usePanelStore } from "@/src/stores/panel-store"

export function DraftInputBridge({ sessionId }: { sessionId?: string }) {
  const controller = usePromptInputController()
  const key = sessionId ?? "draft"
  const draft = useDraftInput((s) => s.drafts[key])
  const pendingInput = usePanelStore((s) => s.pendingInput)

  useEffect(() => {
    if (draft === undefined) return
    const text = useDraftInput.getState().consume(sessionId)
    if (text !== null) controller.textInput.setInput(text)
  }, [draft, controller.textInput, sessionId])

  useEffect(() => {
    if (!pendingInput) return
    if (pendingInput.sessionId !== sessionId) return
    controller.textInput.setInput(pendingInput.text)
    usePanelStore.getState().setPendingInput(null)
  }, [pendingInput, controller.textInput, sessionId])

  return null
}
