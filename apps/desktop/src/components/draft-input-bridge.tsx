import { useEffect } from "react"
import { usePromptInputController } from "@/src/components/ai/prompt-input"
import { useDraftInput } from "@/src/stores/draft-input"
import { usePanelStore } from "@/src/stores/panel-store"

/**
 * Consome o texto pré-preenchido (useDraftInput ou pendingInput do painel)
 * e injeta no textarea. Precisa viver DENTRO do PromptInputProvider.
 * Reage mesmo com o input já montado.
 */
export function DraftInputBridge() {
  const controller = usePromptInputController()
  const draft = useDraftInput((s) => s.text)
  const pendingInput = usePanelStore((s) => s.pendingInput)

  useEffect(() => {
    if (draft === null) return
    const text = useDraftInput.getState().consume()
    if (text !== null) controller.textInput.setInput(text)
  }, [draft, controller.textInput])

  useEffect(() => {
    if (!pendingInput) return
    controller.textInput.setInput(pendingInput)
    usePanelStore.getState().setPendingInput(null)
  }, [pendingInput, controller.textInput])

  return null
}
