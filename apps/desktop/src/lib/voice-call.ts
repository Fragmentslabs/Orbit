import type { ChatMessage, MessagePart, TextPart } from "@shared/chat"

/**
 * Pure pieces of call mode (voice conversation). They live outside the hook so they
 * can be tested without a DOM, microphone or IPC.
 */

/**
 * Level (0..1, see `pcmLevel`) from which a microphone block counts as
 * speech: ~-34 dB. Room noise stays well below; normal voice, well above.
 */
export const SPEECH_LEVEL = 0.35

/**
 * Already speaking, this level (~-41 dB) is enough for the speech to CONTINUE: the end of a
 * syllable, a voice that drops at the end of the sentence and the breathing between sentences
 * do not count as silence. Hysteresis: starting requires more than continuing.
 */
export const SPEECH_CONTINUE_LEVEL = 0.2

/**
 * Is the block speech? Before the first word the high threshold applies; after it, the low
 * one — but never below the room noise (`noise`, measured before the person
 * speaks) with a margin: in an environment with a fan, the pure low threshold would never
 * let the turn end.
 */
export function isSpeech(level: number, speaking: boolean, noise = 0): boolean {
  if (!speaking) return level >= SPEECH_LEVEL
  const floor = Math.min(SPEECH_LEVEL, Math.max(SPEECH_CONTINUE_LEVEL, noise + 0.12))
  return level >= floor
}

/** Moving average of the background noise, fed only with the silence before the speech. */
export function trackNoise(noise: number, level: number): number {
  return noise === 0 ? level : noise * 0.9 + level * 0.1
}

/**
 * Is the person's turn over? Only after they have said something (silence before the
 * first word ends nothing) and after a continuous silence of `silenceMs`.
 */
export function turnEnded(state: { heardSpeech: boolean; lastSpeechAt: number; now: number; silenceMs: number }): boolean {
  return state.heardSpeech && state.now - state.lastSpeechAt >= state.silenceMs
}

/** What the call speaks of an answer (see `callSpeech`). */
export interface CallSpeech {
  /** Prose BEFORE the first tool: spoken as it arrives. */
  lead: string
  /** The answer has already called some tool. */
  hasTool: boolean
  /** With tools: the prose after the last one of them — the final answer. */
  final: string | null
}

const isProse = (part: MessagePart): part is TextPart => part.type === "text" && part.source === undefined
/** Text and reasoning do not break a block; a tool, an agent, an image etc. break it. */
const isTextish = (part: MessagePart) => part.type === "text" || part.type === "reasoning"

/**
 * Reasoning that leaked into the text (` thinking…</think>`, from gateways that do not
 * separate it). A tag still open — the reasoning in the middle of the streaming — takes
 * everything that comes after it along.
 */
export function stripThinking(text: string): string {
  return text.replace(/<think(?:ing)?>[\s\S]*?(<\/think(?:ing)?>|$)/gi, "")
}

/**
 * Speech policy of the call. Speaking ALL the prose of an answer with
 * tools read out loud the narration the model writes between one
 * tool and another ("let me check X… now Y…", sometimes the reasoning
 * itself) — on screen it stays collapsed under "N actions", in the voice it does not. So:
 *
 *   - without tools: the answer is the `lead` itself, spoken in streaming;
 *   - with tools: from the `lead` only the waiting sentence ("let me search")
 *     already spoken; the narration in the middle, never; and the `final` (prose after the last
 *     tool) when the turn ends.
 *
 * Engine texts (with `source`) do not exist for the speech, as on screen.
 */
export function callSpeech(message: ChatMessage): CallSpeech {
  // Compaction summary: context for the model, never speech.
  if (message.role !== "assistant" || message.summary) return { lead: "", hasTool: false, final: null }
  const parts = message.parts.filter((part) => !(part.type === "text" && part.source !== undefined))
  let i = 0
  let lead = ""
  for (; i < parts.length && isTextish(parts[i]); i++) {
    if (isProse(parts[i])) lead += (parts[i] as TextPart).text
  }
  const hasTool = i < parts.length
  if (!hasTool) return { lead: stripThinking(lead), hasTool, final: null }
  let j = parts.length
  while (j > 0 && isTextish(parts[j - 1])) j--
  const tail = stripThinking(
    parts
      .slice(j)
      .filter(isProse)
      .map((part) => part.text)
      .join(""),
  ).trim()
  // The `lead` ended on a tool: the break closes its last sentence.
  return { lead: `${stripThinking(lead)}\n`, hasTool, final: tail || null }
}

/**
 * What can still be SPOKEN of an answer that arrives in pieces: from the point already
 * spoken (`from`) to the end of the last complete sentence. With the answer finished
 * (`final`), everything that is left goes. `next` is the new point already spoken.
 *
 * Speaking sentence by sentence is what keeps the call in real time: the first sentence
 * already plays while the model writes the following ones.
 */
export function takeSpeakable(text: string, from: number, final: boolean): { chunk: string; next: number } {
  const rest = text.slice(from)
  if (final) return { chunk: rest.trim(), next: text.length }
  // End of sentence: punctuation followed by a space/newline, or a line break.
  const boundary = /[.!?…;:](?=\s)|\n/g
  let end = -1
  for (let match = boundary.exec(rest); match; match = boundary.exec(rest)) end = match.index + match[0].length
  if (end <= 0) return { chunk: "", next: from }
  return { chunk: rest.slice(0, end).trim(), next: from + end }
}

/**
 * The beginning of `text` that has already been said, cut at a word boundary: the subtitle
 * of call mode grows along with the audio without cutting a word in half.
 * `fraction` is 0..1 of what has played.
 */
export function spokenPrefix(text: string, fraction: number): string {
  if (!text) return ""
  if (fraction >= 1) return text
  if (!Number.isFinite(fraction) || fraction <= 0) return ""
  const cut = Math.ceil(text.length * fraction)
  if (cut >= text.length) return text
  // The first space after the cut: the word that started only comes in when
  // it is whole (or when it is the last one).
  const rest = text.slice(cut)
  const gap = rest.search(/\s/)
  return gap === -1 ? text : text.slice(0, cut + gap)
}

/**
 * Slice of `text` that belongs to chunk `index` of `total`. It is the path for whoever
 * sends only the sliced audio, without the chunk text (the model route): it divides
 * by words so the slices neither overlap nor leave a hole.
 */
export function speechPieceText(text: string, index: number, total: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || total <= 0 || index < 0 || index >= total) return ""
  if (total === 1) return words.join(" ")
  const start = Math.round((words.length * index) / total)
  const end = Math.round((words.length * (index + 1)) / total)
  return words.slice(start, Math.max(start, end)).join(" ")
}

/** A subtitle line and the stretch it covers in the normalized text. */
export interface CaptionLine {
  text: string
  /** Index of the first character of the line in the normalized text. */
  start: number
  /** Index right after the last character of the line. */
  end: number
}

/** Spaces, line breaks and tabs into a single space — the subtitle's measure. */
export function normalizeSpeech(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * Cuts the speech into short subtitle lines (up to `maxChars`), always at a word
 * boundary: the call panel shows two — the one being said and the
 * next one —, so each line has to fit in one visual line.
 */
export function captionLines(text: string, maxChars = 48): CaptionLine[] {
  const normalized = normalizeSpeech(text)
  if (!normalized) return []
  const lines: CaptionLine[] = []
  let from = 0
  while (from < normalized.length) {
    let end = Math.min(normalized.length, from + maxChars)
    if (end < normalized.length) {
      const space = normalized.lastIndexOf(" ", end)
      if (space > from) end = space
    }
    const line = normalized.slice(from, end).trim()
    if (line) lines.push({ text: line, start: from, end })
    from = end
    while (from < normalized.length && normalized[from] === " ") from++
  }
  return lines
}

/**
 * Index of the line being said for a position (in characters) in the
 * normalized text. Positions in the space between two lines stay on the
 * previous one; the next one only takes over when its first letter begins.
 */
export function captionIndexAt(lines: CaptionLine[], position: number): number {
  let index = 0
  for (let i = 0; i < lines.length; i++) if (lines[i].start <= position) index = i
  return index
}

/**
 * Does the call belong to this composer? Only the id decides: the call always starts
 * with a real session (the composer creates one before connecting when it is in a
 * new chat), so there is no longer a "pending owner" without an id.
 */
export function isCallOwner({
  callSessionId,
  sessionId,
}: {
  callSessionId: string | null
  sessionId?: string
}): boolean {
  return callSessionId != null && callSessionId === sessionId
}

/**
 * Markdown → text that sounds good out loud. The call prompt already asks for plain
 * text; this is the net for what escapes (a bold, a link, a code block).
 */
export function speechText(markdown: string): string {
  return (
    markdown
      // A code block is not read out loud.
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      // [text](url) → text; a loose URL disappears.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      // Heading, quote, list and table markers.
      .replace(/^\s{0,3}(#{1,6}|>)\s*/gm, "")
      .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
      .replace(/\|/g, " ")
      // Emphasis.
      .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, "$2")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim()
  )
}
