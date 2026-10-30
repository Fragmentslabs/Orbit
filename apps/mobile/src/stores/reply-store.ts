import { create } from 'zustand'
import { messageReplyPrefix, type MessageReplyQuote } from '@orbit/shared'

/**
 * Message marked as a reply, waiting for the send (mirror of the desktop).
 *
 * The quoted excerpt enters the SENT TEXT — see formatMessageReply, in shared:
 * the same format on both devices, otherwise the quote from one becomes raw text in the
 * bubble of the other. It is per chat, like the draft; a new chat uses the "draft" key
 * until the first send, when the session-store calls adopt().
 */

const DRAFT_KEY = 'draft'

function keyOf(key: string | null | undefined): string {
  return key ?? DRAFT_KEY
}

interface ReplyState {
  replies: Record<string, MessageReplyQuote>
  setReply: (key: string | null | undefined, reply: MessageReplyQuote) => void
  clearReply: (key: string | null | undefined) => void
  adopt: (sessionId: string) => void
}

export const useReply = create<ReplyState>((set, get) => ({
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

/** Send text with the quote in front, consuming the pending reply. */
export function withReplyPrefix(key: string | null | undefined, text: string): string {
  const reply = useReply.getState().replies[keyOf(key)]
  if (!reply) return text
  useReply.getState().clearReply(key)
  return messageReplyPrefix(reply) + text
}
