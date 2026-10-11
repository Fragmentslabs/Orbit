import { create } from 'zustand'
import { messageReplyPrefix, type MessageReplyQuote } from '@orbit/shared'

/**
 * Mensagem marcada como resposta, esperando o envio (espelho do desktop).
 *
 * O trecho citado entra no TEXTO enviado — ver formatMessageReply, no shared:
 * o mesmo formato nos dois aparelhos, senão a citação de um vira texto cru na
 * bolha do outro. É por chat, como o rascunho; chat novo usa a chave "draft"
 * até o primeiro envio, quando o session-store chama adopt().
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

/** Texto do envio com a citação na frente, consumindo a resposta pendente. */
export function withReplyPrefix(key: string | null | undefined, text: string): string {
  const reply = useReply.getState().replies[keyOf(key)]
  if (!reply) return text
  useReply.getState().clearReply(key)
  return messageReplyPrefix(reply) + text
}
