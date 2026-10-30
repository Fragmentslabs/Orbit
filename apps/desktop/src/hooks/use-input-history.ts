import { useCallback, useEffect, useRef } from "react"
import { historyStep, inputHistory, NO_HISTORY, type HistoryCursor, type HistoryInput } from "@/src/lib/input-history"
import { useMessageReply } from "@/src/stores/message-reply"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * ↑/↓ in the composer: brings back the texts already sent in THIS session (the
 * reverted ones stay out on their own — see inputHistory).
 *
 * Returns the text to put in the field, or `null` when the key is not part of the
 * history and the caret should go its own way.
 *
 * The citation travels with the text: recovering a message that was a reply
 * re-arms the bar in the composer, and going back to the draft returns the citation that
 * was armed before — the same treatment revert gives to the message returned
 * to the input, so that `> [assistant] …` never shows up raw in the field.
 */
export function useInputHistory(
  sessionId: string | undefined,
  replyKey: string,
): (direction: "older" | "newer", input: HistoryInput) => string | null {
  const cursor = useRef<HistoryCursor>(NO_HISTORY)

  // The history is this conversation's: switching chats (or going to a new chat)
  // restarts the navigation from scratch, instead of continuing from where it stopped in the other.
  useEffect(() => {
    cursor.current = NO_HISTORY
  }, [sessionId])

  return useCallback(
    (direction: "older" | "newer", input: HistoryInput) => {
      // The arrow only belongs to the history at the edge of the field — it bails out before building
      // the list, which is the case for every arrow used to move inside the text.
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
