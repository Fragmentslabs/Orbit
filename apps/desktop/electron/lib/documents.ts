import { app } from 'electron'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { extractPdfPages } from './pdf'
import type { CellValue } from './sheet-query'
import {
  capPages,
  documentKindOf,
  paginateText,
  type DocumentKind,
  type DocumentPage,
  type ExtractedDocument,
} from './document-pages'

/**
 * Text layer of documents (PDF, DOCX, spreadsheets) — extraction and cache.
 * The pagination decisions stay in document-pages.ts (pure and tested).
 *
 * Before this layer, a document only existed as an ATTACHMENT: the whole text was
 * extracted and pasted into the message, and toModelMessages resent it on every turn
 * — a 300-page PDF took up the context window forever. And in code
 * mode the agent was simply blind: `read` does readFile(file, 'utf8'), which
 * on a PDF returns binary, and `grep` skips any file with \0.
 *
 * The output is always PAGINATED. A page is the unit of reading because it is the unit
 * that the user and the document already use ("it is on page 40"), and it is what allows
 * reading a stretch without loading the rest:
 *
 *   - PDF    → real pages (pdf-parse returns pages[])
 *   - XLSX   → one page per sheet, and the large sheet broken into row
 *              ranges (with the header repeated in each range)
 *   - DOCX   → synthetic pages by size (the format does not store pagination)
 */

/**
 * Rows per page in a spreadsheet. "Page = sheet" only works while the sheet
 * fits: a sheet of 100 thousand rows has to be paginated internally, otherwise the
 * end of it becomes unreachable — that is how the first version truncated at
 * 2000 rows without ANY offset able to reach the rest.
 */
const ROWS_PER_PAGE = 400

export {
  documentKindOf,
  documentHeader,
  isDocumentPath,
  pageLabel,
  pageLocator,
  pageWindow,
} from './document-pages'
export type { DocumentKind, DocumentPage, ExtractedDocument } from './document-pages'

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'doc-cache')
}

function csvCell(value: unknown): string {
  const s = String(value ?? '')
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Pages of a spreadsheet: it starts with the sheet (the division the spreadsheet already has,
 * and which lets the agent ask for "the costs sheet" without loading the others) and
 * breaks the sheet into row ranges when it is large.
 *
 * The first row is repeated at the top of each range: without the header, a
 * middle range becomes a list of values with no column names — the agent would read
 * "1240,BRL,pending" without knowing what each field is.
 */
function extractSpreadsheetPages(bytes: Buffer): DocumentPage[] {
  const workbook = XLSX.read(bytes, { type: 'buffer' })
  const pages: DocumentPage[] = []

  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
      header: 1,
      raw: false,
      defval: '',
    })
    const asCsv = (row: unknown[]) => row.map(csvCell).join(',')
    const header = rows.length > 0 ? asCsv(rows[0]) : ''

    if (rows.length <= ROWS_PER_PAGE) {
      pages.push({ num: pages.length + 1, label: name, text: rows.map(asCsv).join('\n') })
      continue
    }

    // Large sheet: row ranges, each one a page of its own.
    for (let start = 1; start < rows.length; start += ROWS_PER_PAGE) {
      const slice = rows.slice(start, start + ROWS_PER_PAGE)
      const last = Math.min(start + ROWS_PER_PAGE - 1, rows.length - 1)
      pages.push({
        num: pages.length + 1,
        label: `${name}, rows ${start}-${last} of ${rows.length - 1}`,
        text: [header, ...slice.map(asCsv)].join('\n'),
      })
    }
  }

  return pages
}

async function extractFresh(bytes: Buffer, kind: DocumentKind): Promise<ExtractedDocument> {
  if (kind === 'pdf') return capPages(await extractPdfPages(bytes), kind)
  if (kind === 'spreadsheet') return capPages(extractSpreadsheetPages(bytes), kind)
  // Pasted stretch and downloaded page already arrive as text: just paginate.
  if (kind === 'text' || kind === 'web') {
    return capPages(paginateText(bytes.toString('utf8').trim()), kind)
  }
  const result = await mammoth.extractRawText({ buffer: bytes })
  return capPages(paginateText(result.value.trim()), kind)
}

/**
 * Extracts with an on-disk cache. Extracting is expensive — seconds on a large PDF — and the
 * agent re-reads the same file several times in the same turn (grep locates,
 * read confirms, read continues).
 *
 * The key is the CONTENT HASH, not the path: a renamed or moved file
 * reuses the cache, and an edited file invalidates it on its own — without depending on
 * mtime, which changes on checkout and does not change on an edit that preserves the timestamp.
 */
export async function extractDocument(bytes: Buffer, kind: DocumentKind): Promise<ExtractedDocument> {
  // The type enters the key along with the content: since `text` exists, the
  // same bytes may be read in two ways, and the cache of one would serve the
  // wrong pagination to the other.
  const hash = createHash('sha256').update(kind).update(bytes).digest('hex').slice(0, 32)
  const file = path.join(cacheDir(), `${hash}.json`)

  try {
    const cached = JSON.parse(await fsp.readFile(file, 'utf8')) as ExtractedDocument
    if (Array.isArray(cached.pages)) return cached
  } catch {
    // no cache (or corrupted) — extracts again
  }

  const extracted = await extractFresh(bytes, kind)
  try {
    await fsp.mkdir(cacheDir(), { recursive: true })
    await fsp.writeFile(file, JSON.stringify(extracted), 'utf8')
  } catch {
    // the cache is an optimization: failing to write does not invalidate the result
  }
  return extracted
}

/** Extracts a document from disk (code mode: a file inside the repository). */
export async function extractDocumentFile(filePath: string): Promise<ExtractedDocument> {
  const kind = documentKindOf(filePath)
  if (!kind) throw new Error(`Not a supported document: ${path.basename(filePath)}`)
  return extractDocument(await fsp.readFile(filePath), kind)
}

/**
 * TYPED rows of a sheet, for the query (sheet_query).
 *
 * It uses `raw: true`, unlike the text extraction: there the goal is for the
 * model to READ, and `raw: false` delivers the value already formatted as the spreadsheet
 * displays it; here the goal is to COMPUTE, and a number has to arrive as a number —
 * summing from formatted text would reintroduce the locale parse
 * ("1.234,56") which is where the silent error lives.
 *
 * `sheet` absent = first sheet, which is the case of the single-sheet spreadsheet.
 */
export function readSheetRows(
  bytes: Buffer,
  sheet?: string,
): { rows: CellValue[][]; sheetName: string; sheetNames: string[] } {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: true })
  const sheetNames = workbook.SheetNames
  if (sheetNames.length === 0) throw new Error('The spreadsheet has no sheet.')

  const wanted = sheet?.trim().toLowerCase()
  const sheetName = wanted
    ? sheetNames.find((n) => n.toLowerCase() === wanted) ?? ''
    : sheetNames[0]
  if (!sheetName) {
    throw new Error(`Sheet not found: "${sheet}". Available sheets: ${sheetNames.join(', ')}`)
  }

  const rows = XLSX.utils.sheet_to_json<CellValue[]>(workbook.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: null,
  })
  return { rows, sheetName, sheetNames }
}
