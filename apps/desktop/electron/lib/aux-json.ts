/**
 * Small helpers for answers of an auxiliary model that must come back as one line
 * of text or as a JSON object (MCP descriptions, skill cards).
 */

/** Text on ONE line: no markup characters, whitespace collapsed, cut at `limit`. */
export function oneLine(text: string, limit: number): string {
  return text
    .replace(/[`<>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

/** First JSON object in the answer (fences and preamble tolerated); `{}` when there is none. */
export function parseJson(raw: string): Record<string, unknown> {
  const stripped = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return {}
  }
}
