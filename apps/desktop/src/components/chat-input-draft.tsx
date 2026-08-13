import { useEffect, useRef } from "react"
import { usePromptInputController } from "@/src/components/ai/prompt-input"
import { setInputDraft, getInputDraft, clearInputDraft } from "@/src/stores/chat-draft"

export function ChatInputDraft({ sessionId, draftKey }: { sessionId?: string; draftKey?: string }) {
  const controller = usePromptInputController()
  const key = draftKey ?? sessionId ?? "draft"

  // Chave em que o texto atual foi digitado. O save-on-change usa ela (não a
  // chave do render): numa troca de sessão o valor ainda pertence ao chat
  // anterior quando a key já mudou — salvar na key nova corromperia o rascunho.
  const prevKeyRef = useRef(key)

  // Restaura o rascunho ao montar (volta de outra tela ou reabertura do chat)
  useEffect(() => {
    const saved = getInputDraft(key)
    if (saved) controller.textInput.setInput(saved)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Salva o texto continuamente: o rascunho sobrevive a desmontagens (troca de
  // tela/esteira/memórias, chat ↔ código), não só à troca de chat. Vazio limpa
  // o rascunho (a mensagem foi enviada ou apagada).
  useEffect(() => {
    const text = controller.textInput.value
    if (text) {
      setInputDraft(prevKeyRef.current, text)
    } else {
      clearInputDraft(prevKeyRef.current)
    }
  }, [controller.textInput.value])

  // Troca de chat: salva o texto da sessão anterior (ou limpa o rascunho
  // obsoleto se o input saiu vazio) e restaura o da nova sessão.
  useEffect(() => {
    const prev = prevKeyRef.current
    if (prev !== key) {
      const text = controller.textInput.value
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
