import type { MessagePart, ReasoningPart } from './chat'
import type { ChatViewMode } from './app-settings'
import { lastTextRunStart } from './chat-text'

/**
 * Orders the parts of an answer for the chosen view mode.
 *
 * - `summary`: the reasoning of all steps becomes a single block at the top, and the
 *   actions it separated come together in a single accordion. It is the reading from before:
 *   thought → answer → summary of the actions. The intermediate narration ("thinking
 *   out loud": the text before the last block) leaves the reading and the final answer
 *   takes the place of its first stretch — which is how the message looked before,
 *   when the final text overwrote the first one and only it appeared. What the
 *   person does not see here remains whole in `steps`/`detailed`.
 * - `steps` and `detailed`: each part in the place where it happened; what changes
 *   between the two is only whether the blocks come collapsed or open.
 *
 * Shared because the desktop and the phone must read the same turn the same way: the
 * phone has only this mode, and the two implementations cannot drift apart.
 */
export function arrangeForView(parts: MessagePart[], mode: ChatViewMode): MessagePart[] {
  if (mode !== 'summary') return parts

  const reasoning = parts.filter(
    (p): p is ReasoningPart => p.type === 'reasoning' && p.text.trim() !== '',
  )
  const merged: ReasoningPart | null =
    reasoning.length > 0
      ? {
          id: reasoning[0].id,
          type: 'reasoning',
          text: reasoning.map((p) => p.text.trim()).join('\n\n'),
          state: reasoning.some((p) => p.state === 'streaming') ? 'streaming' : 'done',
          durationMs: reasoning.reduce((sum, p) => sum + (p.durationMs ?? 0), 0) || undefined,
        }
      : null

  // Only the text written by the model without a source (the prose) counts as narration or
  // answer: the engine text ('nudge'/'todo'/'internal') and the vision text stay
  // where they are, with the treatment they already have in the UI.
  const isProse = (part: MessagePart) => part.type === 'text' && part.source === undefined
  const lastRunStart = lastTextRunStart(
    parts.map((part) => ({ kind: 'part', part })),
    true,
  )

  const rest: MessagePart[] = []
  let narrationAt = -1
  parts.forEach((part, index) => {
    if (part.type === 'reasoning') return
    // Intermediate narration: out of the summary (the step-by-step mode shows it)
    if (isProse(part) && index < lastRunStart) {
      if (narrationAt === -1) narrationAt = rest.length
      return
    }
    rest.push(part)
  })

  // With no reasoning to move up and no narration to remove, nothing changes
  if (!merged && narrationAt === -1) return parts

  // Without narration the answer is already in its place; with narration, it moves up to where
  // the first narrated stretch was
  const ordered =
    narrationAt === -1
      ? rest
      : [
          ...rest.slice(0, narrationAt).filter((p) => !isProse(p)),
          ...rest.filter(isProse),
          ...rest.slice(narrationAt).filter((p) => !isProse(p)),
        ]

  return merged ? [merged, ...ordered] : ordered
}
