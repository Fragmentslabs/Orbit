import path from 'node:path'

/**
 * Pure logic of the document layer: which file is a document, how to break it
 * into pages, how to label it and how to announce a stretch to the model.
 *
 * Separated from documents.ts because that one depends on Electron's `app` (the
 * cache directory) and does not load outside the main process — the same split that
 * memory already makes between pure domain and repository. This is where the
 * testable decisions live.
 */

/**
 * Source types. The first three come from a BINARY file; `text`
 * (pasted stretch) and `web` (downloaded page) are already born as text and exist
 * only in the sources panel — there is no extension that brings them from disk, and
 * that is why they do not enter EXTENSIONS: making .txt/.md become a document
 * would change code mode's `read`, which has to keep delivering those
 * files raw.
 */
export type DocumentKind = 'pdf' | 'docx' | 'spreadsheet' | 'text' | 'web'

export interface DocumentPage {
  /** 1-indexed. In a spreadsheet it is the sheet's index; in DOCX, the synthetic block's. */
  num: number
  text: string
  /** Page label when it has a name of its own (the spreadsheet's sheet). */
  label?: string
}

export interface ExtractedDocument {
  kind: DocumentKind
  pages: DocumentPage[]
  totalPages: number
  totalChars: number
  /** true when the document was cut for exceeding the safety limits. */
  truncated: boolean
}

const EXTENSIONS: Record<string, DocumentKind> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'spreadsheet',
  '.xls': 'spreadsheet',
  '.ods': 'spreadsheet',
  '.csv': 'spreadsheet',
}

/**
 * Global ceiling of the extracted text — a barrier against a pathological file, not
 * a usage limit: 8MB of text is on the order of thousands of pages. It exists
 * because the extractor runs in the main process; a malformed file that
 * blew up in memory would freeze the whole app.
 */
export const MAX_TOTAL_CHARS = 8 * 1024 * 1024
/** Target size of a DOCX synthetic page (~1 printed page). */
export const DOCX_PAGE_CHARS = 3000

/** Is the file a document this layer knows how to read? */
export function documentKindOf(filePath: string): DocumentKind | null {
  return EXTENSIONS[path.extname(filePath).toLowerCase()] ?? null
}

export function isDocumentPath(filePath: string): boolean {
  return documentKindOf(filePath) !== null
}

/**
 * Synthetic pages by size, for DOCX: the format does not store
 * pagination (Word computes it when rendering), so it is invented here.
 * The break respects the paragraph — cutting in the middle of a sentence would leave the
 * read stretch incomprehensible precisely at the border, which is where the agent most
 * needs to understand whether it should ask for the next page.
 */
export function paginateText(text: string, targetChars = DOCX_PAGE_CHARS): DocumentPage[] {
  const paragraphs = text.split(/\n{2,}/)
  const pages: DocumentPage[] = []
  let buffer = ''
  const flush = () => {
    if (!buffer.trim()) return
    pages.push({ num: pages.length + 1, text: buffer.trim() })
    buffer = ''
  }
  for (const paragraph of paragraphs) {
    if (buffer && buffer.length + paragraph.length > targetChars) flush()
    buffer += (buffer ? '\n\n' : '') + paragraph
  }
  flush()
  return pages.length > 0 ? pages : [{ num: 1, text: '' }]
}

/**
 * Cuts at the global ceiling preserving WHOLE PAGES: half a page at the end would be
 * worse than one less, because the agent would have no way of knowing that the stretch
 * is incomplete and would cite a mutilated text as if it were the original.
 */
export function capPages(
  pages: DocumentPage[],
  kind: DocumentKind,
  maxChars = MAX_TOTAL_CHARS,
): ExtractedDocument {
  let totalChars = 0
  let truncated = false
  const kept: DocumentPage[] = []
  for (const page of pages) {
    if (totalChars + page.text.length > maxChars) {
      truncated = true
      break
    }
    totalChars += page.text.length
    kept.push(page)
  }
  return { kind, pages: kept, totalPages: kept.length, totalChars, truncated }
}

/** Page label to show the model ("p. 12" or the sheet's name). */
export function pageLabel(page: DocumentPage, kind: DocumentKind): string {
  if (page.label) return `sheet "${page.label}"`
  return kind === 'docx' ? `block ${page.num}` : `p. ${page.num}`
}

/**
 * Compact locator for a search result. It ALWAYS carries the number that
 * serves as the `offset` when reading, because that is what the agent needs to read
 * around the result — and the sheet's name when it exists, which is the useful handle
 * in a spreadsheet.
 *
 * The type appears in the label on purpose: saying "p12" on a DOCX would make the agent
 * cite to the user a page that Word does not have (the pagination there is ours,
 * synthetic), and in a spreadsheet it would make "page 3" mean the third sheet.
 */
export function pageLocator(page: DocumentPage, kind: DocumentKind): string {
  if (kind === 'spreadsheet') return `sheet${page.num}${page.label ? ` (${page.label})` : ''}`
  return kind === 'docx' ? `block${page.num}` : `p${page.num}`
}

/**
 * Numbers the lines of a page, in the format `12| text`.
 *
 * It is what makes the citation VERIFIABLE: without a line number, the model can only
 * point to the page, and the user who clicks lands in a block of text having to
 * look for the cited stretch on their own — which is exactly the check that the
 * citation was supposed to spare. The numbering is per page (and not continuous in the
 * document) because the locator already carries the page, and restarting keeps the
 * numbers short.
 *
 * The cost is on the order of 5% of the page's text, paid on every read; the trade is
 * deliberate.
 */
export function numberLines(text: string, width = 3): string {
  return text
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(width, ' ')}| ${line}`)
    .join('\n')
}

/**
 * Clickable reference to a stretch, in the format the renderer understands.
 *
 * The line enters the address itself instead of the stretch going as free text:
 * free text would require the model to repeat the citation without getting a
 * character wrong and also to encode it in the URL, and any divergence would leave the
 * highlight silently empty.
 *
 * A FRAGMENT, and not a scheme of its own: the answer's markdown goes through
 * rehype-sanitize, which accepts only http/https/mailto/tel and DELETES the href of
 * any other protocol — the link reached the renderer with no address at all and
 * the citation became an inert number. A fragment has no protocol, so it
 * crosses intact; and, unlike a fake domain, in the worst case it does not
 * navigate anywhere.
 */
export function sourceAnchor(docId: string, page: number, fromLine?: number, toLine?: number): string {
  const lines = fromLine ? `L${fromLine}${toLine && toLine > fromLine ? `-${toLine}` : ''}` : ''
  return `#orbit-source/${docId}/p${page}${lines}`
}

/** Requested page window, normalized against the document's limits. */
export function pageWindow(
  doc: ExtractedDocument,
  offset: number | undefined,
  limit: number | undefined,
  defaultPages: number,
  maxPages: number,
): { from: number; to: number; pages: DocumentPage[] } {
  const from = Math.min(Math.max(offset ?? 1, 1), Math.max(doc.totalPages, 1))
  const count = Math.min(Math.max(limit ?? defaultPages, 1), maxPages)
  const pages = doc.pages.slice(from - 1, from - 1 + count)
  return { from, to: from + Math.max(pages.length, 1) - 1, pages }
}

/**
 * Header that accompanies EVERY partial read. Without it the model has no way of
 * knowing that there is a document beyond the stretch — and it answers as if it had read
 * the whole thing, which is exactly the error this layer exists to avoid. That is why
 * it carries the total and says how to continue.
 */
export function documentHeader(
  filePath: string,
  doc: ExtractedDocument,
  shown: { from: number; to: number },
): string {
  const unit = doc.kind === 'spreadsheet' ? 'sheets' : doc.kind === 'docx' ? 'blocks' : 'pages'
  const range = shown.from === shown.to ? `${shown.from}` : `${shown.from}-${shown.to}`
  const rest =
    shown.to < doc.totalPages
      ? ` There is more document: use offset=${shown.to + 1} to continue, or grep to find the relevant part.`
      : ''
  const cut = doc.truncated ? ' (document truncated at the size limit)' : ''
  return `<document path="${filePath}" kind="${doc.kind}" ${unit}="${doc.totalPages}" showing="${range}"${cut}>${rest}`
}
