export const MAX_TITLE_LENGTH = 50

// Thinking models (DeepSeek R1, Qwen QwQ, OpenAI o1/o3, Gemini Thinking etc.)
// emit ` thinking...</think>` blocks. Some providers/gateways do not separate
// the reasoning properly and those tokens leak into the returned `text` — when the
// block is filtered and only the opening of the tag is left, the title is born with `<think`
// glued to the front. It also removes end/start-of-turn tokens from other
// models (ChatML, Llama, Mistral) that rarely show up in badly
// configured gateways.
function stripThinkingAndArtifacts(text: string): string {
  return text
    // Complete reasoning block (with closing) — it may show up in
    // any place; some providers do not separate reasoning properly.
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // Stray open/close tag OR partial without `>` (the model cut it, the gateway
    // leaked it). Anchored on "<think" so as not to eat legitimate text.
    .replace(/<\/?think(?:ing)?\b[^>]*>?/gi, '')
    // End/start-of-turn tokens of specific models (ChatML,
    // Anthropic specials, Llama/Mistral end-of-turn).
    .replace(/<\/?(?:s|antml(?::text|_thinking)?)\s*>/gi, '')
    .replace(/<\||\|>/g, '')
    .replace(/\[\/?INST\]/g, '')
}

// When the user's message is a task ("list the files…"), some
// models (DeepSeek via opencode-go) execute instead of giving a title and return
// the tool call as text: DeepSeek's DSML (`<invoke …>`,
// with the full-width bar U+FF5C), `<｜tool▁calls▁begin｜>` tokens,
// `<toolcall>`/`<tool_call>`/`<function_call>`, Mistral's `[TOOL_CALLS]` or
// raw JSON with `name` + `arguments`. None of that can become a title.
const TOOL_CALL_MARKERS = [
  /[｜|]\s*DSML\s*[｜|]/i,
  /<\s*[｜|]\s*tool[\s▁_]*call/i,
  /<\s*\/?\s*(?:tool[\s_-]?calls?|function[\s_-]?calls?|invoke|antml:invoke)\b/i,
  /<function=/i,
  /\[TOOL_CALLS\]/i,
  /"(?:name|tool|function)"\s*:\s*"[^"]*"\s*,\s*"(?:arguments|parameters|input|args)"\s*:/i,
]

export function looksLikeToolCall(text: string): boolean {
  if (TOOL_CALL_MARKERS.some((re) => re.test(text))) return true
  // Raw JSON (object or list) is never a readable title
  return /^[{[]/.test(text.trim())
}

export function truncateTitle(text: string): string {
  const cleaned = stripThinkingAndArtifacts(text)
    .trim()
    .replace(/\*\*/g, '') // bold/strong markup
    .replace(/[*_`#>~]/g, '') // other markdown markup
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned
  // cuts at the character limit WITHOUT breaking a word in the middle, when possible
  const hard = cleaned.slice(0, MAX_TITLE_LENGTH)
  const lastSpace = hard.lastIndexOf(' ')
  const cut = lastSpace > MAX_TITLE_LENGTH * 0.5 ? lastSpace : hard.length
  return hard.slice(0, cut).trim()
}

// Fallback title taken from the message itself: the first sentence of the first
// non-empty line usually says what it is about ("Code navigation benchmark.
// Use…" → "Code navigation benchmark").
export function titleFromUserText(userText: string): string {
  const firstLine = userText.split('\n').find((line) => line.trim()) ?? ''
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? ''
  return truncateTitle(firstSentence.replace(/[.!?]+$/, ''))
}

/**
 * Fallback title when the message has no text (attachment only): the file
 * name is the only clue to the subject, and without it a chat opened with a PDF
 * stayed forever on the default title.
 *
 * "Rental agreement.pdf" → "Rental agreement". The extension leaves (noise in a
 * title), but only when it really is an extension: in "v1.2" the ".2" stays.
 */
export function titleFromAttachmentNames(
  files: { filename?: string; chip?: boolean }[] | undefined,
): string {
  const name = (files ?? []).find((f) => !f.chip && f.filename?.trim())?.filename?.trim()
  if (!name) return ''
  const extension = /\.[a-z0-9]{1,8}$/i.exec(name)
  const base = extension && /[a-z]/i.test(extension[0].slice(1))
    ? name.slice(0, extension.index)
    : name
  return truncateTitle(base.replace(/[_-]+/g, ' ').trim())
}

/**
 * Converts the title model's answer into a final title. If it comes with tool
 * call markup (or is empty after the cleanup), it falls back to
 * `fallback` — the title derived from the user's message.
 */
export function resolveTitle(modelText: string, fallback: string): string {
  if (looksLikeToolCall(modelText)) return fallback
  return truncateTitle(modelText) || fallback
}
