import { create } from "zustand"
import { messageReplyPrefix, type MessageReplyQuote } from "@shared/chat"

/**
 * Mensagem marcada como resposta, esperando o envio.
 *
 * Guarda o trecho citado e o papel de quem escreveu — o que o compositor
 * prepende no texto na hora de enviar (ver formatMessageReply, no shared).
 * É por chat, como o rascunho: responder uma mensagem de um chat e trocar de
 * conversa não pode levar a citação junto. Chat novo usa a chave "draft" até o
 * primeiro envio, quando o session-store chama adopt().
 */

const DRAFT_KEY = "draft"

/** Chave do balde: a mesma regra do rascunho (draftKey ?? sessionId ?? "draft"). */
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
 * Texto do envio com a citação na frente, consumindo a resposta pendente.
 *
 * Existe para os quatro caminhos de envio (Enter, fila, agendamento, painel
 * lateral) não repetirem a montagem — e, principalmente, para nenhum deles
 * esquecer de LIMPAR a resposta depois de enviar.
 */
export function withReplyPrefix(key: string | null | undefined, text: string): string {
  const reply = useMessageReply.getState().replies[keyOf(key)]
  if (!reply) return text
  useMessageReply.getState().clearReply(key)
  return messageReplyPrefix(reply) + text
}
