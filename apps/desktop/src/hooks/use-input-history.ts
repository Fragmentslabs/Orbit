import { useCallback, useEffect, useRef } from "react"
import { historyStep, inputHistory, NO_HISTORY, type HistoryCursor, type HistoryInput } from "@/src/lib/input-history"
import { useMessageReply } from "@/src/stores/message-reply"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * ↑/↓ no compositor: traz de volta os textos já enviados NESTA sessão (as
 * revertidas ficam de fora sozinhas — ver inputHistory).
 *
 * Devolve o texto a colocar no campo, ou `null` quando a tecla não é do
 * histórico e o caret deve seguir o caminho dele.
 *
 * A citação anda junto com o texto: recuperar uma mensagem que era resposta
 * rearma a barra no compositor, e voltar ao rascunho devolve a citação que
 * estava armada antes — o mesmo tratamento que o revert dá à mensagem devolvida
 * ao input, para o `> [assistant] …` nunca aparecer cru no campo.
 */
export function useInputHistory(
  sessionId: string | undefined,
  replyKey: string,
): (direction: "older" | "newer", input: HistoryInput) => string | null {
  const cursor = useRef<HistoryCursor>(NO_HISTORY)

  // O histórico é o desta conversa: trocar de chat (ou ir para um chat novo)
  // recomeça a navegação do zero, em vez de continuar de onde parou no outro.
  useEffect(() => {
    cursor.current = NO_HISTORY
  }, [sessionId])

  return useCallback(
    (direction: "older" | "newer", input: HistoryInput) => {
      // A seta só é do histórico na ponta do campo — sai antes de montar a
      // lista, que é o caso de toda seta usada para andar dentro do texto.
      if (direction === "older" ? !input.atStart : !input.atEnd) return null

      const messages = sessionId ? useSessionStore.getState().messages[sessionId] : undefined
      const armed = useMessageReply.getState().replies[replyKey] ?? null
      const step = historyStep(inputHistory(messages), cursor.current, input, direction, armed)
      if (!step) return null

      cursor.current = step.cursor
      if (step.entry.reply) useMessageReply.getState().setReply(replyKey, step.entry.reply)
      else useMessageReply.getState().clearReply(replyKey)
      return step.entry.text
    },
    [sessionId, replyKey],
  )
}
