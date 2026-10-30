import { parseMessageReply, type ChatMessage, type MessageReplyQuote } from "@shared/chat"
import { visibleMessageText } from "@/src/lib/message-utils"

/**
 * Composer ↑/↓ history: the texts the person already sent in this
 * conversation, from the most recent to the oldest.
 *
 * The source is the session's `messages` — the same list the bubble draws. That is why
 * a reverted message does not get in: revert TRUNCATES the list and keeps the
 * discarded one in `SessionRevert.discardedMessages` (see revertToMessage), which
 * is not read from here. Undoing the revert gives the messages back and they count
 * again, like any other.
 *
 * The only UX decision lives here, and it is pure so it can be tested: the arrow belongs to the
 * CARET while it has somewhere to go. Only at the edge of the field (↑ at the first
 * position, ↓ at the last one) does it become history — that is what lets a multi-line
 * prompt be navigated line by line before switching messages.
 */

export interface HistoryEntry {
  /** What the person wrote, without the reply citation. */
  text: string
  /** The armed reply that came with the send, if there was one. */
  reply: MessageReplyQuote | null
}

export interface HistoryCursor {
  /** Position in the list (0 = the most recent); null = outside the navigation. */
  index: number | null
  /** What was in the field when the navigation started. */
  draft: string
  /** The citation that was armed at that moment. */
  reply: MessageReplyQuote | null
}

export const NO_HISTORY: HistoryCursor = { index: null, draft: "", reply: null }

export interface HistoryInput {
  /** What is in the field now. */
  text: string
  /** The caret is at the first position — only then does ↑ belong to the history. */
  atStart: boolean
  /** The caret is at the last position — only then does ↓ belong to the history. */
  atEnd: boolean
}

export interface HistoryStep {
  cursor: HistoryCursor
  entry: HistoryEntry
}

/**
 * What the FIELD tells the navigation: the text and where the caret is. `null`
 * when the arrow does not belong to the history — with a selection it replaces the
 * selection, as in any field.
 *
 * The rule is about the EDGE only, and it holds for any text, single-line or multi-line: a
 * long text WRAPS into several lines on screen without a single "\n", and there
 * ↑ in the middle has to go up one visual line, not switch messages. That is why the
 * decision looks at the caret position, never at the number of lines in the value.
 *
 * Receives the textarea and reads `value`/`selectionStart` FROM IT, not the React state:
 * what counts is what is on screen.
 */
export function historyKeyInput(field: {
  value: string
  selectionStart: number
  selectionEnd: number
}): HistoryInput | null {
  if (field.selectionStart !== field.selectionEnd) return null
  return {
    text: field.value,
    atStart: field.selectionStart === 0,
    atEnd: field.selectionStart === field.value.length,
  }
}

/**
 * Texts sent by the person in this session, from the most recent to the oldest.
 *
 * - only `role: "user"` — what the model said is not composition history;
 * - only what the person typed: `visibleMessageText` leaves out the text
 *   extracted from an attachment, and `parseMessageReply` separates the citation from the body (the
 *   `> [assistant] …` would come back raw into the field);
 * - a message without text (attachment only) does not get in, nor does text repeated in sequence:
 *   going up twice has to bring different things.
 */
export function inputHistory(messages: ChatMessage[] | undefined): HistoryEntry[] {
  if (!messages?.length) return []
  const entries: HistoryEntry[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "user") continue
    const { reply, body } = parseMessageReply(visibleMessageText(message))
    const text = body.trim()
    if (!text) continue
    if (entries[entries.length - 1]?.text === text) continue
    entries.push({ text, reply })
  }
  return entries
}

/**
 * One step in the navigation. `null` when the key is not part of the history — and then the
 * caret goes its normal way: with nothing to bring, ↑ at the top of the list,
 * ↓ outside the navigation, or an arrow in the middle of a multi-line text.
 */
export function historyStep(
  history: HistoryEntry[],
  cursor: HistoryCursor,
  input: HistoryInput,
  direction: "older" | "newer",
  currentReply: MessageReplyQuote | null,
): HistoryStep | null {
  if (history.length === 0) return null

  if (direction === "older") {
    // ↑ in the middle of the text moves the caret; the history only starts at the first position.
    if (!input.atStart) return null
    if (cursor.index === null) {
      // The navigation starts: what was typed becomes the draft at the end of the list.
      return {
        cursor: { index: 0, draft: input.text, reply: currentReply },
        entry: history[0],
      }
    }
    const index = Math.min(cursor.index + 1, history.length - 1)
    if (index === cursor.index) return null
    return { cursor: { ...cursor, index }, entry: history[index] }
  }

  // ↓ only at the last position, and only from inside the navigation.
  if (!input.atEnd || cursor.index === null) return null
  const index = cursor.index - 1
  // Went past the most recent one: returns what was being typed.
  if (index < 0) {
    return {
      cursor: NO_HISTORY,
      entry: { text: cursor.draft, reply: cursor.reply },
    }
  }
  return { cursor: { ...cursor, index }, entry: history[index] }
}
