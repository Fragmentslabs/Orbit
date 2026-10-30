import { createRequire } from 'node:module'

/**
 * Editing an EXISTING .docx while preserving the formatting.
 *
 * The strategy is surgical copying, not regeneration: we start from the original
 * bytes and swap only the requested text inside `word/document.xml`. Everything
 * else — styles, fonts, header, footer, images, numbering — remains
 * exactly as in the source file, because it was never touched.
 *
 * The cheap alternative (read with mammoth, turn into Markdown, regenerate with our
 * renderer) would lose precisely the formatting, which is the reason for editing an
 * existing document instead of writing a new one.
 *
 * The REAL OBSTACLE is run fragmentation. Word breaks a sentence into several
 * `<w:r>` because of revision marks and spell checker, so a
 * sentence visible in the document almost never exists as a contiguous string in the XML —
 * searching for it naively finds nothing. Here the search is done over the
 * CONCATENATED text of the paragraph, with an index back to (run, position),
 * and the swap is stitched across the affected runs.
 */

const _require = createRequire(import.meta.url)

export interface Replacement {
  find: string
  replace: string
  /** Replaces every occurrence (default: only the first). */
  all?: boolean
}

/**
 * STRUCTURE changes — what the text swap cannot reach: one more item in the
 * list, one more row in the table, a paragraph that goes away.
 *
 * All of them start from something that already exists in the file and CLONE it. It is the same
 * principle as the text swap: the new paragraph inherits the style, numbering, font and
 * indentation of a real paragraph in the document, and the new row inherits the borders,
 * shading and column widths of a real row of the table. Nothing is
 * drawn from scratch, and that is why nothing looks off.
 *
 * Without this, asking "add an item" had no tool, and the feature was
 * rewriting the whole document in Markdown — which is exactly the path that
 * throws away the formatting the user wanted to keep.
 */
export interface StructuralEdits {
  /** New paragraphs after the paragraph that contains `after`. */
  insert?: { after: string; text: string; like?: string }[]
  /** Removes the paragraph that contains the text. */
  remove?: { containing: string; all?: boolean }[]
  /** New row in a table, after the row that contains `after`. */
  rows?: { after: string; cells: string[] }[]
  /** Removes the table row that contains the text. */
  removeRows?: { containing: string }[]
}

export interface EditResult {
  bytes: Buffer
  /** How many replacements each entry produced, in the order received. */
  applied: number[]
  /** Per structural operation, in the order received: how many times it was applied.
   *  Zero is an anchor not found (or a refused removal, see removeParagraph). */
  structural: { insert: number[]; remove: number[]; rows: number[]; removeRows: number[] }
}

interface RunText {
  /** The <w:t> element whose text enters the concatenation. */
  node: Element
  start: number
  end: number
}

type XmlDoc = Document

function textNodes(paragraph: Element): RunText[] {
  const out: RunText[] = []
  let offset = 0
  // Only <w:t> counts as the paragraph's text. <w:delText> (text already marked as
  // deleted in a revision) is left out on purpose: it does not appear in the
  // accepted document, and editing it would change a history, not the content.
  const nodes = paragraph.getElementsByTagName('w:t')
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes.item(i)
    if (!node) continue
    const text = node.textContent ?? ''
    out.push({ node: node as unknown as Element, start: offset, end: offset + text.length })
    offset += text.length
  }
  return out
}

/**
 * Writes `value` into the <w:t>, taking care of the space.
 *
 * Without `xml:space="preserve"`, Word discards space at the start and end of the
 * run — the sentence comes out with the words glued together, and the error only shows up
 * when opening the file.
 */
function setText(node: Element, value: string): void {
  node.textContent = value
  if (/^\s|\s$/.test(value)) node.setAttribute('xml:space', 'preserve')
}

/**
 * Applies a replacement in the paragraph. The new text enters WHOLE in the first
 * run of the occurrence, inheriting the formatting from there; the following runs lose the
 * part that matched. It is the behavior that preserves the look when the sentence
 * crosses different formats (half in bold, for example).
 */
function replaceInParagraph(
  paragraph: Element,
  find: string,
  replacement: string,
  all: boolean,
): number {
  if (find === '') return 0
  let count = 0

  for (;;) {
    // Rebuilds the index on every round: the previous replacement changed the
    // run sizes, so the old positions are no longer valid.
    const runs = textNodes(paragraph)
    if (runs.length === 0) return count
    const full = runs.map((r) => r.node.textContent ?? '').join('')
    const at = full.indexOf(find)
    if (at < 0) return count

    const end = at + find.length
    for (const run of runs) {
      if (run.end <= at || run.start >= end) continue
      const text = run.node.textContent ?? ''
      const from = Math.max(0, at - run.start)
      const to = Math.min(text.length, end - run.start)
      const isFirst = run.start <= at && run.end > at
      setText(run.node, text.slice(0, from) + (isFirst ? replacement : '') + text.slice(to))
    }
    count += 1
    if (!all) return count

    // A replacement that contains the searched one ("X" → "XY") would repeat forever.
    if (replacement.includes(find)) return count
  }
}

/** Applies the replacements in the whole document, paragraph by paragraph. */
export function applyReplacements(doc: XmlDoc, replacements: Replacement[]): number[] {
  const paragraphs = doc.getElementsByTagName('w:p')
  return replacements.map((r) => {
    let total = 0
    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs.item(i)
      if (!p) continue
      total += replaceInParagraph(p as unknown as Element, r.find, r.replace, r.all ?? false)
      if (total > 0 && !r.all) break
    }
    return total
  })
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

function paragraphText(paragraph: Element): string {
  return textNodes(paragraph)
    .map((r) => r.node.textContent ?? '')
    .join('')
}

function allParagraphs(doc: XmlDoc): Element[] {
  const list = doc.getElementsByTagName('w:p')
  const out: Element[] = []
  for (let i = 0; i < list.length; i++) {
    const p = list.item(i)
    if (p) out.push(p as unknown as Element)
  }
  return out
}

function findParagraph(doc: XmlDoc, containing: string): Element | null {
  return allParagraphs(doc).find((p) => paragraphText(p).includes(containing)) ?? null
}

function ancestor(node: Element, tag: string): Element | null {
  let current = node.parentNode as Element | null
  while (current && current.nodeType === 1) {
    if (current.nodeName === tag) return current
    current = current.parentNode as Element | null
  }
  return null
}

function childrenNamed(node: Element, tag: string): Element[] {
  const out: Element[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (child as Element).nodeName === tag) out.push(child as Element)
  }
  return out
}

/**
 * Swaps ALL the text of a paragraph, keeping the formatting of the first run
 * with text. The other text runs leave; what is not text (revision
 * markers, bookmarks) stays where it was.
 *
 * An empty paragraph has no run to inherit from: then the new run copies the
 * paragraph mark's properties (w:pPr/w:rPr), which is how Word
 * would format what someone typed there.
 */
function setParagraphText(paragraph: Element, text: string): void {
  const doc = paragraph.ownerDocument
  const runs = Array.from({ length: paragraph.getElementsByTagName('w:r').length }, (_, i) =>
    paragraph.getElementsByTagName('w:r').item(i) as unknown as Element,
  ).filter(Boolean)
  const withText = runs.filter((r) => r.getElementsByTagName('w:t').length > 0)
  const keep = withText[0]

  for (const run of withText.slice(1)) run.parentNode?.removeChild(run)

  if (keep) {
    const ts = keep.getElementsByTagName('w:t')
    for (let i = ts.length - 1; i >= 1; i--) {
      const t = ts.item(i)
      t?.parentNode?.removeChild(t)
    }
    setText(ts.item(0) as unknown as Element, text)
    return
  }

  // The paragraph's own namespace, and not a constant: it is the one the rest
  // of the document uses, and a run in a different namespace would not be the same w:r.
  const ns = paragraph.namespaceURI || W_NS
  const run = doc.createElementNS(ns, 'w:r')
  const pPr = childrenNamed(paragraph, 'w:pPr')[0]
  const markRpr = pPr ? childrenNamed(pPr, 'w:rPr')[0] : undefined
  if (markRpr) run.appendChild(markRpr.cloneNode(true))
  const t = doc.createElementNS(ns, 'w:t')
  run.appendChild(t)
  setText(t as unknown as Element, text)
  paragraph.appendChild(run)
}

function insertParagraphs(
  doc: XmlDoc,
  after: string,
  text: string,
  like: string | undefined,
): number {
  const anchor = findParagraph(doc, after)
  if (!anchor) return 0
  const model = like ? findParagraph(doc, like) : anchor
  if (!model) return 0

  // One line per paragraph: \n in the text becomes sibling paragraphs, all on the
  // template's mold — it is the "add these three items" all at once.
  let reference: Element = anchor
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const clone = model.cloneNode(true) as Element
    setParagraphText(clone, line)
    reference.parentNode?.insertBefore(clone, reference.nextSibling)
    reference = clone
  }
  return lines.length
}

/**
 * Removes the paragraph. The exception is the LAST paragraph of a table cell:
 * the format requires at least one per cell, and Word calls the file corrupt if there is
 * none — then the paragraph stays and only its text leaves.
 */
function removeParagraph(doc: XmlDoc, containing: string, all: boolean): number {
  let count = 0
  for (const paragraph of allParagraphs(doc)) {
    if (!paragraphText(paragraph).includes(containing)) continue
    const cell = ancestor(paragraph, 'w:tc')
    if (cell && childrenNamed(cell, 'w:p').length <= 1) setParagraphText(paragraph, '')
    else paragraph.parentNode?.removeChild(paragraph)
    count += 1
    if (!all) break
  }
  return count
}

function insertRow(doc: XmlDoc, after: string, cells: string[]): number {
  const anchor = findParagraph(doc, after)
  const row = anchor ? ancestor(anchor, 'w:tr') : null
  if (!row) return 0

  const clone = row.cloneNode(true) as Element
  childrenNamed(clone, 'w:tc').forEach((cell, index) => {
    // Each cell is left with a single paragraph — the first, which carries the column's
    // style — and receives the value of its position.
    const paragraphs = childrenNamed(cell, 'w:p')
    for (const extra of paragraphs.slice(1)) cell.removeChild(extra)
    if (paragraphs[0]) setParagraphText(paragraphs[0], cells[index] ?? '')
  })
  row.parentNode?.insertBefore(clone, row.nextSibling)
  return 1
}

/** Removes the row — except the last one of the table, which would leave an empty table. */
function removeRow(doc: XmlDoc, containing: string): number {
  const anchor = findParagraph(doc, containing)
  const row = anchor ? ancestor(anchor, 'w:tr') : null
  const table = row ? ancestor(row, 'w:tbl') : null
  if (!row || !table || childrenNamed(table, 'w:tr').length <= 1) return 0
  table.removeChild(row)
  return 1
}

/** Applies the structure changes, over the text AS IT IS in the file. */
export function applyStructural(doc: XmlDoc, edits: StructuralEdits): EditResult['structural'] {
  return {
    insert: (edits.insert ?? []).map((op) => insertParagraphs(doc, op.after, op.text, op.like)),
    rows: (edits.rows ?? []).map((op) => insertRow(doc, op.after, op.cells)),
    removeRows: (edits.removeRows ?? []).map((op) => removeRow(doc, op.containing)),
    remove: (edits.remove ?? []).map((op) => removeParagraph(doc, op.containing, op.all ?? false)),
  }
}

/**
 * Opens the .docx, applies the changes and returns a NEW file. The original
 * is never touched — whoever calls decides where to write.
 *
 * The structure comes BEFORE the text: the anchors of the insertions and removals point
 * to the text as it is in the file, and a swap made before would change what
 * they look for. The order is fixed and is in the tool's description, so the model
 * does not have to guess.
 */
export async function editDocx(
  original: Buffer,
  replacements: Replacement[],
  structure: StructuralEdits = {},
): Promise<EditResult> {
  const JSZip = _require('jszip') as typeof import('jszip')
  const { DOMParser, XMLSerializer } = _require('@xmldom/xmldom') as typeof import('@xmldom/xmldom')

  const zip = await JSZip.loadAsync(original)
  const entry = zip.file('word/document.xml')
  if (!entry) throw new Error('Invalid .docx file: word/document.xml not found.')

  const xml = await entry.async('string')
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as XmlDoc
  const structural = applyStructural(doc, structure)
  const applied = applyReplacements(doc, replacements)

  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc as never))
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { bytes, applied, structural }
}

/** Running text of the document, so the agent can locate what it wants to swap. */
export async function readDocxParagraphs(original: Buffer): Promise<string[]> {
  const JSZip = _require('jszip') as typeof import('jszip')
  const { DOMParser } = _require('@xmldom/xmldom') as typeof import('@xmldom/xmldom')
  const zip = await JSZip.loadAsync(original)
  const entry = zip.file('word/document.xml')
  if (!entry) throw new Error('Invalid .docx file: word/document.xml not found.')
  const doc = new DOMParser().parseFromString(await entry.async('string'), 'text/xml')
  const paragraphs = doc.getElementsByTagName('w:p')
  const out: string[] = []
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs.item(i)
    if (!p) continue
    out.push(textNodes(p as unknown as Element).map((r) => r.node.textContent ?? '').join(''))
  }
  return out
}
