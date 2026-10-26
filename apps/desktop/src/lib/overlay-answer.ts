import type { ChatMessage } from "@shared/chat"
import { stripThinking } from "@/src/lib/voice-call"

/**
 * O que o painel mostra da última resposta.
 *
 * Num turno com ferramentas o modelo escreve texto pelo caminho ("vou trazer o
 * Notas pra frente…") e uma mensagem final. Mostrar tudo colado, como antes,
 * não bate com a voz — que só fala a espera do começo e a mensagem final (ver
 * `callSpeech`). Então:
 *  - trabalhando: a última narração, em cinza (`progress`);
 *  - terminou: só a mensagem final (`final`) — a que está sendo falada, e a que
 *    fica na tela no modo texto. Sem texto depois da última ferramenta, vale a
 *    última narração.
 * Sem ferramentas, o texto é a própria resposta e aparece enquanto chega.
 */
export interface AnswerView {
  final: string
  progress: string
}

export function assistantView(messages: ChatMessage[] | undefined, since: number, busy: boolean): AnswerView {
  const empty = { final: "", progress: "" }
  if (!messages) return empty
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== "assistant" || message.summary) continue
    if (since > 0 && message.createdAt < since) return empty
    const parts = message.parts.filter((part) => !(part.type === "text" && part.source === "internal"))
    const textOf = (from: number, to?: number) =>
      parts
        .slice(from, to)
        .flatMap((part) => (part.type === "text" ? [stripThinking(part.text).trim()] : []))
        .filter(Boolean)
    let lastWork = -1
    parts.forEach((part, index) => {
      if (part.type !== "text" && part.type !== "reasoning") lastWork = index
    })
    if (lastWork < 0) return { final: textOf(0).join("\n\n"), progress: "" }
    const narration = textOf(0).at(-1) ?? ""
    if (busy) return { final: "", progress: narration }
    return { final: textOf(lastWork + 1).join("\n\n") || narration, progress: "" }
  }
  return empty
}
