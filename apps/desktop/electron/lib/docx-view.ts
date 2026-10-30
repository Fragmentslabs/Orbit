import fsp from 'node:fs/promises'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { DOCX_PAGE_BREAK_MARK } from '@shared/page-breaks'
import { docxHeadFoot, withHeadFoot } from './docx-headfoot'
import { sanitizeDocxHtml } from './docx-sanitize'
import { sessionDocumentFile } from './session-documents'

/**
 * An attached .docx, seen as a document.
 *
 * The panel only knew how to draw PDF: the .docx was stored, but opened it became
 * the extracted text's list of lines — title, table and bold flattened
 * into a numbered column, as if it were code. mammoth, which is already in the
 * project for the agent documents' preview, converts the file into HTML
 * with its structure: headings, lists, tables, emphasis and the
 * embedded images.
 *
 * The HTML comes from a file from outside, so it leaves here clean: only what mammoth
 * writes, with no event handler, and with every link pointing outside the
 * app — a `javascript:` in a .docx hyperlink cannot become code
 * running in the panel.
 *
 * Pagination: the .docx does not store pages, but it stores the breaks the author
 * forced — and those were what vanished, leaving the whole document on a single sheet.
 * The two functions below preserve them: `normalizePageBreaks` makes Word say the
 * break the way mammoth understands it, and `markPageBreaks` leaves the mark in the
 * HTML for the panel to cut the sheets.
 */

/** The run break, which is the form mammoth reads (Word's Ctrl+Enter). */
const PAGE_BREAK_RUN = '<w:r><w:br w:type="page"/></w:r>'

/**
 * Word stores the page break in two ways: `<w:br w:type="page"/>`
 * inside a run (Ctrl+Enter) and `<w:pageBreakBefore/>` in the
 * paragraph properties ("page break before"). mammoth understands the first and **silently
 * ignores the second** — which is precisely the one our .docx generator
 * writes, and the one Word uses when the break is a paragraph property.
 *
 * Here the pPr markup becomes the corresponding run break, at the start of the
 * same paragraph: Word draws the same thing, and the original file is not
 * touched. A zip that does not open comes back as it was.
 */
export async function normalizePageBreaks(buffer: Buffer): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(buffer)
    const file = zip.file('word/document.xml')
    if (!file) return buffer
    const xml = await file.async('string')
    if (!xml.includes('<w:pageBreakBefore')) return buffer
    const fixed = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
      if (!paragraph.includes('<w:pageBreakBefore')) return paragraph
      const withoutBreak = paragraph.replace(/<w:pageBreakBefore\s*\/>/g, '')
      // The end of pPr, if any: the break enters right after, as the first run.
      const head = /^<w:p(?:\s[^>]*)?>(?:\s*<w:pPr>[\s\S]*?<\/w:pPr>)?/.exec(withoutBreak)
      if (!head) return withoutBreak
      return `${head[0]}${PAGE_BREAK_RUN}${withoutBreak.slice(head[0].length)}`
    })
    if (fixed === xml) return buffer
    zip.file('word/document.xml', fixed)
    return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
  } catch {
    // Strange package: it goes on with the original, which still opens in the panel.
    return buffer
  }
}

type DocNode = {
  type?: string
  breakType?: string
  value?: string
  children?: DocNode[]
}

function isPageBreak(node: DocNode): boolean {
  return node.type === 'break' && node.breakType === 'page'
}

/** The paragraph that carries only the mark — it is where the panel cuts the sheet. */
function breakParagraph(): DocNode {
  return {
    type: 'paragraph',
    children: [{ type: 'run', children: [{ type: 'text', value: DOCX_PAGE_BREAK_MARK }] }],
  }
}

/**
 * A paragraph cut at the break points, with the mark in a paragraph of its own.
 * The cut is on the MODEL, before the HTML, so as never to split a tag in half.
 */
function splitParagraph(paragraph: DocNode): DocNode[] {
  const out: DocNode[] = []
  let runs: DocNode[] = []
  const flush = () => {
    if (runs.length > 0) out.push({ ...paragraph, children: runs })
    runs = []
  }
  for (const run of paragraph.children ?? []) {
    if (run.type !== 'run' || !Array.isArray(run.children) || !run.children.some(isPageBreak)) {
      runs.push(run)
      continue
    }
    let pieces: DocNode[] = []
    for (const inner of run.children) {
      if (!isPageBreak(inner)) {
        pieces.push(inner)
        continue
      }
      if (pieces.length > 0) runs.push({ ...run, children: pieces })
      pieces = []
      flush()
      out.push(breakParagraph())
    }
    if (pieces.length > 0) runs.push({ ...run, children: pieces })
  }
  flush()
  return out.length > 0 ? out : [paragraph]
}

/**
 * The breaks become a marker paragraph in the document mammoth converts.
 * Only the body's paragraphs are cut: a break inside a table cell does not
 * exist in Word, and cutting there would split the table in two.
 */
export function markPageBreaks(document: DocNode): DocNode {
  if (!Array.isArray(document.children)) return document
  const children: DocNode[] = []
  for (const child of document.children) {
    if (child.type === 'paragraph') children.push(...splitParagraph(child))
    else children.push(child)
  }
  return { ...document, children }
}

/**
 * A .docx file as clean HTML, wherever it comes from. Both origins — the
 * conversation's attachment and the document the agent edited — go through here, so
 * that neither is left without the sanitization.
 */
export async function docxFileToHtml(filePath: string): Promise<{ html: string } | null> {
  try {
    const buffer = await fsp.readFile(filePath)
    const { value } = await mammoth.convertToHtml(
      { buffer: await normalizePageBreaks(buffer) },
      { transformDocument: (document) => markPageBreaks(document as DocNode) },
    )
    // mammoth only converts the body; header and footer come separately.
    return { html: sanitizeDocxHtml(withHeadFoot(value, await docxHeadFoot(buffer))) }
  } catch {
    // Corrupted file or a format mammoth does not read: the panel falls back
    // to Text mode, which keeps working with what was extracted.
    return null
  }
}

export async function renderSessionDocx(
  sessionId: string,
  docId: string,
): Promise<{ html: string } | null> {
  const file = await sessionDocumentFile(sessionId, docId)
  if (!file || file.ext !== 'docx') return null
  try {
    return await docxFileToHtml(file.path)
  } catch {
    // Corrupted file or a format mammoth does not read: the panel falls back
    // to Text mode, which keeps working with what was extracted.
    return null
  }
}
