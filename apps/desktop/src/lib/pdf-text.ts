/**
 * Locating a stretch inside the positioned text of a PDF page.
 *
 * Runs in the RENDERER, from the items that came along with the image. Before,
 * this was done in main on every search, which forced redrawing the whole
 * page on every typed letter — and the panel blinked "loading". With the
 * items in hand, searching is a string search and the highlight shows up without
 * any round trip to main.
 *
 * The coordinates are FRACTIONS of the page (0 to 1), so they hold at any
 * zoom: changing the scale invalidates nothing.
 */

export interface PdfTextItem {
  x: number
  y: number
  width: number
  height: number
  text: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Removes the spaces for the comparison.
 *
 * The PDF breaks the sentence into several items and the position of the spaces between them is not
 * reliable — "a destination" may arrive as "a", "des", "tino". Gluing everything
 * and searching the equally glued stretch is what matches in practice.
 */
function squash(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase()
}

/**
 * Rectangles of ALL occurrences of the stretch on the page.
 *
 * All of them, and not only the first: in a search the word usually repeats on the same
 * page, and marking only one would make the counter say 7 while the page shows 1.
 */
export function locateText(items: PdfTextItem[], needle: string, max = 200): Rect[] {
  const target = squash(needle)
  if (target.length < 2 || items.length === 0) return []

  let flat = ""
  const spans: { from: number; to: number; item: PdfTextItem }[] = []
  for (const item of items) {
    const piece = squash(item.text)
    if (!piece) continue
    spans.push({ from: flat.length, to: flat.length + piece.length, item })
    flat += piece
  }

  const rects: Rect[] = []
  let at = flat.indexOf(target)
  while (at >= 0 && rects.length < max) {
    const end = at + target.length
    for (const span of spans) {
      if (span.to <= at || span.from >= end) continue
      rects.push({
        x: span.item.x,
        y: span.item.y,
        width: span.item.width,
        height: span.item.height,
      })
    }
    at = flat.indexOf(target, at + target.length)
  }
  return rects
}

/**
 * Horizontal factor so the selection layer touches the drawn text.
 *
 * The layer is made of transparent spans over the image: the real text is in the
 * pixel, and these spans exist only to give selection and copy. Without correction they
 * would be wider or narrower than the glyphs and the selection mark
 * would come out crooked. The estimate uses half a height per character, which is the
 * average proportion of body text fonts — it is an approximation, not a measurement.
 */
export function selectionScaleX(item: PdfTextItem, aspect: number): number {
  const chars = item.text.length
  if (chars === 0 || item.height <= 0 || aspect <= 0) return 1
  // `height` is a fraction of the HEIGHT and `width` is a fraction of the WIDTH: comparing the
  // two requires going through the page proportion, otherwise the factor comes out wrong on
  // everything that is not square.
  const estimated = (chars * item.height * 0.5) / aspect
  if (estimated <= 0) return 1
  return Math.min(3, Math.max(0.2, item.width / estimated))
}
