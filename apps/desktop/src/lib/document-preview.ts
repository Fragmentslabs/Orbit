/** Primeira linha que diz alguma coisa: nem título (já está no card), nem
 *  régua, nem marcação crua. */
export function firstLine(markdown: string): string | null {
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || /^(-{3,}|\*{3,}|_{3,})$/.test(line) || line === "\\pagebreak") continue
    const text = line
      .replace(/^[-*+>]\s+|^\d+[.)]\s+/, "")
      .replace(/[*`]/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\\(.)/g, "$1")
      .trim()
    if (text) return text.length > 110 ? `${text.slice(0, 110)}…` : text
  }
  return null
}
