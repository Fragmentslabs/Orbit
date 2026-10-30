import { DOCUMENT_QUOTE_MIME, motionTimecode, type FilePart, type QuotePayload } from "@shared/chat"
import type { DocumentQuote, PanelQuote } from "@/src/stores/panel-store"

/**
 * Citation → message attachment.
 *
 * The two composers (chat and code) need this at send time, and the
 * format has to be identical in both: whoever reads it on the other side is a single `if` in the
 * engine's preprocessAttachment. Duplicating the serialization would be the easiest
 * way for them to diverge without anyone noticing.
 *
 * It holds for both origins: the document stretch (page/lines) and the motion
 * instant (file/frame/fps). The payload `kind` says which one it is.
 */

/** Where the stretch is, in the short format the chip and the attachment name use. */
export function quoteLocationLabel(quote: DocumentQuote): string {
  if (!quote.page) return ""
  if (!quote.fromLine) return ` p${quote.page}`
  const to = quote.toLine && quote.toLine > quote.fromLine ? `-${quote.toLine}` : ""
  return ` p${quote.page}L${quote.fromLine}${to}`
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** The chip label: `contrato.pdf p3L10-14` or `Motion · index.html @ 00:02:09`.
 *  "Motion" is the product name (the same label as the tab), not a word to
 *  translate. */
export function quoteChipLabel(quote: PanelQuote): string {
  if (quote.kind === "design") {
    const what = quote.elementPath?.length ? `<${quote.tag ?? "?"}>${quote.label ? ` ${quote.label}` : ""}` : (quote.boardTitle ?? quote.file)
    return `Design · ${quote.file} · ${what}`
  }
  if (quote.kind === "motion") {
    // The piece focus may be a layer (a DOM element) or a sound track:
    // both are selected the same way, and the chip shows the name that was
    // clicked without having to say which of the two it is.
    const focused = quote.layer ?? quote.audio
    return `Motion · ${baseName(quote.file)} @ ${motionTimecode(quote.frame, quote.fps)}${focused ? ` · ${focused}` : ""}`
  }
  return `${quote.name}${quoteLocationLabel(quote)}`
}

/** What the cursor stopped over the chip shows: the quoted stretch or the
 *  composition path — what the person needs to know WHAT is attached. */
export function quoteChipTitle(quote: PanelQuote): string {
  if (quote.kind === "design") return quote.text || quote.html || quote.file
  return quote.kind === "motion" ? quote.file : quote.text
}

/** The payload as it travels in the data URL. Each type carries ONLY its own fields: the
 *  motion citation has no page or line, and emitting the empty keys would make
 *  the model text be born with orphan fields. */
function quotePayload(quote: PanelQuote): QuotePayload {
  if (quote.kind === "design") {
    return {
      kind: "design",
      name: quote.name,
      file: quote.file,
      ...(quote.path ? { path: quote.path } : {}),
      ...(quote.boardTitle ? { boardTitle: quote.boardTitle } : {}),
      ...(quote.elementPath?.length ? { elementPath: quote.elementPath } : {}),
      ...(quote.tag ? { tag: quote.tag } : {}),
      ...(quote.label ? { label: quote.label } : {}),
      ...(quote.text ? { text: quote.text } : {}),
      ...(quote.html ? { html: quote.html } : {}),
    }
  }
  if (quote.kind === "motion") {
    return {
      kind: "motion",
      file: quote.file,
      name: quote.name,
      frame: quote.frame,
      fps: quote.fps,
      ...(quote.path ? { path: quote.path } : {}),
      ...(quote.layer ? { layer: quote.layer } : {}),
      ...(quote.audio ? { audio: quote.audio } : {}),
      ...(quote.onScreen?.length ? { onScreen: quote.onScreen } : {}),
    }
  }
  return {
    kind: quote.kind,
    docId: quote.docId,
    name: quote.name,
    page: quote.page,
    fromLine: quote.fromLine,
    toLine: quote.toLine,
    text: quote.text,
  }
}

export function quotesToFileParts(quotes: PanelQuote[]): FilePart[] {
  return quotes.map((quote) => {
    const payload = encodeURIComponent(JSON.stringify(quotePayload(quote)))
    return {
      id: quote.id,
      type: "file",
      mime: DOCUMENT_QUOTE_MIME,
      filename: quoteChipLabel(quote),
      url: `data:${DOCUMENT_QUOTE_MIME},${payload}`,
    }
  })
}

/**
 * On which lines of the page the selected stretch is.
 *
 * It serves the PDF Original mode, where the selection happens over the text layer
 * drawn on top of the image: there the pieces are glyph positions,
 * not lines, and there is no line number in the DOM to read. The path is to find
 * the text back in the SAME line list the model sees — which is what
 * guarantees the citation leads to the right line.
 *
 * The comparison ignores spaces for the same reason as the PDF `locateText`: the
 * file breaks the sentence into pieces and the position of the spaces between them is not
 * reliable. Join everything, search together, and translate the offset back into a
 * line number.
 */
export function locateLines(
  lines: string[],
  needle: string,
): { fromLine: number; toLine?: number } | null {
  const squash = (text: string) => text.replace(/\s+/g, "").toLowerCase()
  const target = squash(needle)
  if (target.length < 2) return null

  let flat = ""
  const spans: { from: number; to: number; line: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    const piece = squash(lines[i])
    if (!piece) continue
    spans.push({ from: flat.length, to: flat.length + piece.length, line: i + 1 })
    flat += piece
  }

  const at = flat.indexOf(target)
  if (at < 0) return null
  const end = at + target.length

  const fromLine = spans.find((s) => at < s.to)?.line
  if (!fromLine) return null
  const toLine = [...spans].reverse().find((s) => end > s.from)?.line
  return { fromLine, toLine: toLine && toLine > fromLine ? toLine : undefined }
}
