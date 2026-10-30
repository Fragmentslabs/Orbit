import type { ChatMessage } from "@shared/chat"
import { stripThinking } from "@/src/lib/voice-call"

/**
 * What the panel shows of the last answer.
 *
 * In a turn with tools the model writes text along the way ("I'll bring the
 * Notes forward…") and a final message. Showing everything glued together, as before,
 * does not match the voice — which only speaks the opening wait and the final
 * message (see `callSpeech`). So:
 *  - working: the last narration, in gray (`progress`);
 *  - finished: only the final message (`final`) — the one being spoken, and the one that
 *    stays on the screen in text mode. Without text after the last tool, the
 *    last narration counts.
 * Without tools, the text is the answer itself and shows up as it arrives.
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
