const MAX = 48

/** A first name for a routine, from its instruction: the first sentence, cut at a word. */
export function deriveTitle(prompt: string): string {
  const first = (prompt.trim().split(/[.!?\n]/)[0] ?? "").replace(/\s+/g, " ").trim()
  if (!first) return ""
  const titled = first.charAt(0).toUpperCase() + first.slice(1)
  if (titled.length <= MAX) return titled
  const cut = titled.slice(0, MAX)
  const space = cut.lastIndexOf(" ")
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`
}
