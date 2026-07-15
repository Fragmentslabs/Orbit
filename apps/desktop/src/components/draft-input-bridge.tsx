import { useEffect } from "react"
import { usePromptInputController } from "@/src/components/ai/prompt-input"
import { useDraftInput } from "@/src/stores/draft-input"

/**
 * Consome o texto pré-preenchido (useDraftInput) e injeta no textarea.
 * Precisa viver DENTRO do PromptInputProvider. Reage mesmo com o input já
 * montado (ex: settings abre um novo chat com "/create-skill ").
 */
export function DraftInputBridge() {
  const controller = usePromptInputController()
  const draft = useDraftInput((s) => s.text)

  useEffect(() => {
    if (draft === null) return
    const text = useDraftInput.getState().consume()
    if (text !== null) controller.textInput.setInput(text)
  }, [draft, controller.textInput])

  return null
}
