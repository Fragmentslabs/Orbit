import { create } from "zustand"
import { messageReplyPrefix, type MessageReplyQuote } from "@shared/chat"

/**
 * Message marked as a reply, waiting for the send.
 *
 * It keeps the cited stretch and the role of whoever wrote it — what the composer
 * prepends to the text at send time (see formatMessageReply, in shared).
 * It is per chat, like the draft: replying to a message in one chat and switching
 * conversation cannot carry the citation along. A new chat uses the "draft" key until the
 * first send, when the session-store calls adopt().
 */

const DRAFT_KEY = "draft"

/** Bucket key: the same rule as the draft (draftKey ?? sessionId ?? "draft"). */
function keyOf(key: string | null | undefined): string {
  return key ?? DRAFT_KEY
}

interface MessageReplyState {
  replies: Record<string, MessageReplyQuote>
  setReply: (key: string | null | undefined, reply: MessageReplyQuote) => void
  clearReply: (key: string | null | undefined) => void
  adopt: (sessionId: string) => void
}

export const useMessageReply = create<MessageReplyState>((set, get) => ({
  replies: {},
  setReply: (key, reply) =>
    set((s) => ({ replies: { ...s.replies, [keyOf(key)]: reply } })),
  clearReply: (key) => {
    const k = keyOf(key)
    if (get().replies[k] === undefined) return
    const next = { ...get().replies }
    delete next[k]
    set({ replies: next })
  },
  adopt: (sessionId) => {
    const { replies } = get()
    if (replies[DRAFT_KEY] === undefined) return
    const next = { ...replies }
    next[sessionId] = next[DRAFT_KEY]
    delete next[DRAFT_KEY]
    set({ replies: next })
  },
}))

/**
 * Send text with the citation in front, consuming the pending reply.
 *
 * It exists so the four send paths (Enter, queue, scheduling, side
 * panel) do not repeat the assembly — and, mainly, so that none of them
 * forgets to CLEAR the reply after sending.
 */
export function withReplyPrefix(key: string | null | undefined, text: string): string {
  const reply = useMessageReply.getState().replies[keyOf(key)]
  if (!reply) return text
  useMessageReply.getState().clearReply(key)
  return messageReplyPrefix(reply) + text
}
