/**
 * Consulta de recuperação a partir da conversa recente.
 *
 * Mensagens como "E quanto custaria?" ou "Quero o mais barato" não dizem do que
 * se trata sozinhas. Em vez de mandar a conversa inteira ao embedding (o que
 * puxaria assuntos antigos), a consulta contextual junta a mensagem atual a um
 * trecho compacto do turno anterior — e só é usada quando a mensagem isolada
 * não achou evidência (ver `needsContextRetry`), para a troca de assunto
 * ("E o código da academia?") não herdar o tema da conversa anterior.
 */

import { lexTokens } from "./memory-retrieval"

export interface ChatTurn {
  role: "user" | "assistant"
  text: string
}

export interface QueryBuildOptions {
  /** Teto de caracteres do contexto anexado */
  maxContextChars?: number
  /** Quantos turnos para trás olhar */
  maxTurns?: number
}

export interface RetrievalQuery {
  /** Texto para o embedding */
  semantic: string
  /** Texto original da mensagem (busca lexical) */
  lexical: string
  usedContext: boolean
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`
}

/** Mensagem curta o bastante para depender do que veio antes. */
export function isShortMessage(message: string, maxTokens = 8): boolean {
  return lexTokens(message).length <= maxTokens
}

/** Só a mensagem atual: texto semântico e lexical iguais. */
export function isolatedQuery(message: string): RetrievalQuery {
  const text = message.trim()
  return { semantic: text, lexical: text, usedContext: false }
}

/**
 * Mensagem + trecho compacto do contexto: a pergunta anterior do usuário e o
 * fim da última resposta do assistente (onde costuma estar o assunto). O texto
 * lexical continua sendo só a mensagem original.
 */
export function contextualQuery(message: string, recent: ChatTurn[], options: QueryBuildOptions = {}): RetrievalQuery {
  const budget = options.maxContextChars ?? 360
  const turns = recent.slice(-(options.maxTurns ?? 4))
  const lastUser = [...turns].reverse().find((t) => t.role === "user")
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant")
  const parts: string[] = []
  if (lastUser) parts.push(clip(lastUser.text, Math.floor(budget * 0.55)))
  if (lastAssistant) {
    const sentences = lastAssistant.text.split(/(?<=[.!?。！？])\s+/).filter(Boolean)
    parts.push(clip(sentences.slice(-2).join(" "), Math.floor(budget * 0.45)))
  }
  const context = parts.join(" ")
  const text = message.trim()
  if (!context) return isolatedQuery(text)
  return { semantic: `${context}\n${text}`, lexical: text, usedContext: true }
}

/**
 * Vale refazer a busca com contexto? Só quando a mensagem é curta, há contexto
 * e a busca isolada não encontrou evidência (nem injeção nem ponteiro).
 */
export function needsContextRetry(
  message: string,
  hasContext: boolean,
  isolatedFoundEvidence: boolean,
  maxTokens = 8,
): boolean {
  return hasContext && !isolatedFoundEvidence && isShortMessage(message, maxTokens)
}
