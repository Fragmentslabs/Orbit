/**
 * Retrieval query from the recent conversation.
 *
 * Messages like "And how much would it cost?" or "I want the cheapest" do not say what
 * they are about on their own. Instead of sending the whole conversation to the embedding (which
 * would pull in old subjects), the contextual query joins the current message to a
 * compact snippet of the previous turn — and it is only used when the isolated message
 * found no evidence (see `needsContextRetry`), so that a change of subject
 * ("And the gym code?") does not inherit the theme of the previous conversation.
 */

import { lexTokens } from "./memory-retrieval"

export interface ChatTurn {
  role: "user" | "assistant"
  text: string
}

export interface QueryBuildOptions {
  /** Character cap of the attached context */
  maxContextChars?: number
  /** How many turns back to look */
  maxTurns?: number
}

export interface RetrievalQuery {
  /** Text for the embedding */
  semantic: string
  /** Original text of the message (lexical search) */
  lexical: string
  usedContext: boolean
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`
}

/** Message short enough to depend on what came before. */
export function isShortMessage(message: string, maxTokens = 8): boolean {
  return lexTokens(message).length <= maxTokens
}

/** Only the current message: semantic and lexical text equal. */
export function isolatedQuery(message: string): RetrievalQuery {
  const text = message.trim()
  return { semantic: text, lexical: text, usedContext: false }
}

/**
 * Message + compact snippet of the context: the previous question from the user and the
 * end of the last assistant answer (where the subject usually is). The lexical text
 * remains only the original message.
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
 * Is it worth redoing the search with context? Only when the message is short, there is context
 * and the isolated search found no evidence (neither injection nor pointer).
 */
export function needsContextRetry(
  message: string,
  hasContext: boolean,
  isolatedFoundEvidence: boolean,
  maxTokens = 8,
): boolean {
  return hasContext && !isolatedFoundEvidence && isShortMessage(message, maxTokens)
}
