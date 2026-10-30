import { useEffect, useRef } from "react"
import { usePromptInputController } from "@/src/components/ai/prompt-input"
import { setInputDraft, getInputDraft, clearInputDraft } from "@/src/stores/chat-draft"

export function ChatInputDraft({ sessionId, draftKey }: { sessionId?: string; draftKey?: string }) {
  const controller = usePromptInputController()
  const key = draftKey ?? sessionId ?? "draft"

  // Key in which the current text was typed. save-on-change uses it (not the
  // render key): on a session switch the value still belongs to the previous
  // chat when the key has already changed — saving under the new key would corrupt the draft.
  const prevKeyRef = useRef(key)

  // Restores the draft on mount (coming back from another screen or reopening the chat)
  useEffect(() => {
    const saved = getInputDraft(key)
    if (saved) controller.textInput.setInput(saved)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Saves the text continuously: the draft survives unmounts (switching
  // screen/pipeline/memories, chat ↔ code), not only switching chats. Empty
  // clears
  // the draft (the message was sent or deleted).
  useEffect(() => {
    const text = controller.textInput.value
    if (text) {
      setInputDraft(prevKeyRef.current, text)
    } else {
      clearInputDraft(prevKeyRef.current)
    }
  }, [controller.textInput.value])

  // Chat switch: saves the text of the previous session (or clears the draft
  // obsolete if the input left empty) and restores the one of the new session.
  useEffect(() => {
    const prev = prevKeyRef.current
    if (prev !== key) {
      const text = controller.textInput.value
      if (text) {
        setInputDraft(prev, text)
      } else {
        // The input left the previous session empty: any draft saved from it
        // is obsolete (the message was sent or deleted). Without that cleanup,
        // the sent text would come back to the input when reopening the chat.
        clearInputDraft(prev)
      }
      const saved = getInputDraft(key)
      controller.textInput.setInput(saved)
      prevKeyRef.current = key
    }
  }, [key, controller.textInput])

  return null
}
