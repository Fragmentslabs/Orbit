import { useEffect, useRef } from "react"
import { usePromptInputController } from "@/src/components/ai/prompt-input"
import { setInputDraft, getInputDraft, clearInputDraft } from "@/src/stores/chat-draft"

export function ChatInputDraft({ sessionId }: { sessionId?: string }) {
  const controller = usePromptInputController()
  const key = sessionId ?? "draft"
  const prevKeyRef = useRef(key)
  const valueRef = useRef(controller.textInput.value)
  valueRef.current = controller.textInput.value

  useEffect(() => {
    const saved = getInputDraft(key)
    if (saved) controller.textInput.setInput(saved)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const prev = prevKeyRef.current
    if (prev !== key) {
      const text = valueRef.current
      if (text) {
        setInputDraft(prev, text)
      } else {
        // O input saiu vazio da sessão anterior: qualquer rascunho salvo dela
        // está obsoleto (a mensagem foi enviada ou apagada). Sem essa limpeza,
        // o texto enviado voltaria ao input ao reabrir o chat.
        clearInputDraft(prev)
      }
      const saved = getInputDraft(key)
      controller.textInput.setInput(saved)
      prevKeyRef.current = key
    }
  }, [key, controller.textInput])

  return null
}
