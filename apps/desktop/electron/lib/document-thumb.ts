import sharp from 'sharp'

/**
 * Thumbnail of a document in the Sources tab.
 *
 * The per-type icon says the FORMAT, and that is the least important information when the
 * list grows: five PDFs become five identical icons. The thumbnail says WHICH
 * document it is — from the face of the first page, which is how the person recognizes a
 * file they attached themselves.
 *
 * Two paths, because not every source has a page:
 *
 * - PDF is real page 1, rendered by the same pdfjs as the viewer.
 * - The rest (DOCX, spreadsheet, pasted text, site) has no image at all
 *   stored — what exists is the extracted text. So the thumbnail DRAWS a
 *   sheet with the first lines, which is what a file manager does
 *   and what makes two pasted texts distinguishable from each other.
 *
 * No BrowserWindow in the second case: the SVG goes straight into sharp, which rasterizes
 * it. That is why the text is drawn here and not in HTML.
 */

/** Stored size — 2x what is displayed, so as not to blur on a hidpi screen. */
export const THUMB_WIDTH = 160
/** ~1:1.3 proportion, that of an upright A4 sheet. */
export const THUMB_HEIGHT = 208

/** Lines that fit on the drawn sheet, at the font size below. */
const TEXT_LINES = 13
const FONT_SIZE = 7.5
const LINE_HEIGHT = 11
/** Average width of a character, to cut the line before it leaks off the sheet. */
const CHAR_WIDTH = 3.9
const PADDING = 11

/**
 * Font chain with a representative from each platform. It is not decoration:
 * if none resolves, librsvg draws the sheet EMPTY instead of erroring — it is
 * the case `looksBlank` below catches.
 */
const FONT_STACK = 'Segoe UI, DejaVu Sans, Liberation Sans, Helvetica, Arial, sans-serif'

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The first useful lines of the text.
 *
 * A blank line does not become a line of the thumbnail: in a double-spaced document,
 * half the sheet would be empty. A long line is cut at what fits —
 * breaking it in two would spend another content line's space.
 */
function previewLines(text: string, max: number): string[] {
  const limit = Math.floor((THUMB_WIDTH - PADDING * 2) / CHAR_WIDTH)
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line) continue
    lines.push(line.length > limit ? `${line.slice(0, limit - 1)}…` : line)
    if (lines.length >= max) break
  }
  return lines
}

/** The drawn sheet: white background, a thin border and the text. */
function pageSvg(lines: string[]): string {
  const text = lines
    .map(
      (line, i) =>
        `<text x="${PADDING}" y="${PADDING + 8 + i * LINE_HEIGHT}" font-family="${FONT_STACK}" font-size="${FONT_SIZE}" fill="#3f3f46">${escapeXml(line)}</text>`,
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}">
    <rect width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" fill="#ffffff"/>
    <rect x="0.5" y="0.5" width="${THUMB_WIDTH - 1}" height="${THUMB_HEIGHT - 1}" fill="none" stroke="#e4e4e7"/>
    ${text}
  </svg>`
}

/**
 * The same sheet, with bars in place of the text.
 *
 * It is the plan B for when no font resolved: `<rect>` does not depend on
 * fontconfig, so this draws on any machine. The length of each
 * bar follows the real line's, which still distinguishes a dense paragraph from
 * a short list.
 */
function skeletonSvg(lines: string[]): string {
  const bars = lines
    .map((line, i) => {
      const width = Math.max(12, Math.min(THUMB_WIDTH - PADDING * 2, line.length * CHAR_WIDTH))
      return `<rect x="${PADDING}" y="${PADDING + 3 + i * LINE_HEIGHT}" width="${width}" height="3.5" rx="1.5" fill="#d4d4d8"/>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}">
    <rect width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" fill="#ffffff"/>
    <rect x="0.5" y="0.5" width="${THUMB_WIDTH - 1}" height="${THUMB_HEIGHT - 1}" fill="none" stroke="#e4e4e7"/>
    ${bars}
  </svg>`
}

/**
 * Did the sheet come out blank?
 *
 * It serves a single case, but a real one: without an installed font librsvg does not complain —
 * it returns the clean sheet. Counting dark pixels is what separates "rendered" from
 * "rendered nothing", and it is cheap on a 160x208 image.
 *
 * It measures only the MIDDLE, cropping the frame: that is drawn with `<rect>` and comes out
 * the same in both cases, so counting it would take for rendered a sheet in
 * which no letter appeared.
 *
 * And the cut is low on purpose. A pasted text of two lines paints little
 * more than a hundred pixels at the size this is drawn at; a cut calibrated
 * for a "full sheet" would discard the short text, which is precisely the case in which
 * the cover helps most to tell one source from another.
 */
const BLANK_MARGIN = 3
const INK_LEVEL = 200
const MIN_INK_PIXELS = 20

async function looksBlank(png: Buffer): Promise<boolean> {
  try {
    const { data } = await sharp(png)
      .extract({
        left: BLANK_MARGIN,
        top: BLANK_MARGIN,
        width: THUMB_WIDTH - BLANK_MARGIN * 2,
        height: THUMB_HEIGHT - BLANK_MARGIN * 2,
      })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    let ink = 0
    for (let i = 0; i < data.length; i++) {
      if (data[i] < INK_LEVEL && ++ink > MIN_INK_PIXELS) return false
    }
    return true
  } catch {
    return false
  }
}

async function toWebp(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer()
}

/**
 * Thumbnail drawn from the document's text.
 *
 * It never throws: the thumbnail is decoration, and a source without a thumbnail keeps
 * being perfectly usable in the list (the type icon comes back).
 */
export async function textThumb(text: string): Promise<Buffer | null> {
  const lines = previewLines(text, TEXT_LINES)
  if (lines.length === 0) return null
  try {
    const rendered = await sharp(Buffer.from(pageSvg(lines))).png().toBuffer()
    if (!(await looksBlank(rendered))) return sharp(rendered).webp({ quality: 80 }).toBuffer()
    return await toWebp(skeletonSvg(lines))
  } catch {
    try {
      return await toWebp(skeletonSvg(lines))
    } catch {
      return null
    }
  }
}

/**
 * Thumbnail of the rendered first page of a PDF.
 *
 * `contain` over white, and not `cover`: cropping the page to fill the
 * frame would cut precisely the top, which is where the title by which the
 * person recognizes the document is.
 */
export async function pageThumb(png: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(png)
      .resize({
        width: THUMB_WIDTH,
        height: THUMB_HEIGHT,
        fit: 'contain',
        background: '#ffffff',
      })
      .webp({ quality: 78 })
      .toBuffer()
  } catch {
    return null
  }
}
