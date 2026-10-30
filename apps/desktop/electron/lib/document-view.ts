import fsp from 'node:fs/promises'
import { extractDocument } from './documents'
import { saveExport } from './export-dialog'
import { documentFilePath, ensureDocumentRender, getMediaEntry } from './media'
import { docxFileToHtml, renderSessionDocx } from './docx-view'
import { printFile, rasterizePdf, type PdfOutlineItem, type PdfTextItem } from './pdf-raster'
import {
  exportSessionDocument,
  printSessionDocument,
  readSessionText,
  renderSessionPages,
  type SessionDocumentView,
} from './session-documents'

/**
 * What the side panel needs from a document, wherever it comes from.
 *
 * They are two origins with different storage: the conversation's SOURCES (attachments
 * and folder sources, in session-docs/) and the DOCUMENTS the agent produced
 * (in the media gallery). The panel is a single one — the user opens "a PDF" and expects
 * outline, find, zoom, print and download in both cases.
 *
 * The id says the origin: `doc1`/`src2` are conversation sources; anything else is a
 * gallery record. That is why the facade does not need a type parameter
 * that whoever calls would have to get right.
 *
 * The sources have their own path (and do not fall into the generic one) because not all of them are
 * files: a pasted stretch and a downloaded page are born as text and have no bytes
 * to rasterize nor to download.
 */

/** Conversation source id. The rest is a gallery id (doc_xxxx.md). */
const SESSION_DOC = /^(doc|src)[0-9]+$/

function isSessionDoc(id: string): boolean {
  return SESSION_DOC.test(id)
}

/**
 * File of a gallery document: the PDF when there is one, otherwise the .docx.
 *
 * Neither of them on disk is the NORMAL case — a document written by the agent
 * is born only in Markdown. Since this viewer works over the rendered file
 * (that is where the pages, the outline and the printing come from), the PDF is
 * generated here, on the first opening, and cached.
 */
async function mediaFile(id: string): Promise<{ path: string; ext: 'pdf' | 'docx' } | null> {
  for (const ext of ['pdf', 'docx'] as const) {
    const file = await documentFilePath(id, ext)
    if (file) return { path: file, ext }
  }
  const rendered = await ensureDocumentRender(id, 'pdf')
  return rendered ? { path: rendered, ext: 'pdf' } : null
}

/** Paginated text of the document, for Text mode and for the search count. */
export async function viewText(
  sessionId: string,
  id: string,
): Promise<SessionDocumentView | null> {
  if (isSessionDoc(id)) return readSessionText(sessionId, id)

  const file = await mediaFile(id)
  if (!file) return null
  const entry = await getMediaEntry(id)
  try {
    const bytes = await fsp.readFile(file.path)
    // It extracts from the RENDERED FILE, and not from the source Markdown: that is what makes
    // page 3 of the text be the page 3 that the image shows. The extraction's
    // cache is by content hash, so it re-reads for free.
    const extracted = await extractDocument(bytes, file.ext === 'pdf' ? 'pdf' : 'docx')
    return {
      id,
      filename: entry?.name ?? id,
      kind: file.ext === 'pdf' ? 'pdf' : 'docx',
      totalPages: extracted.totalPages,
      pages: extracted.pages.map((p) => ({
        num: p.num,
        label: p.label,
        lines: p.text.split('\n'),
      })),
      // The .docx also has an original: it is drawn as a document in HTML
      // (viewHtml), and not as pages. Before this only the PDF entered, and the .docx the
      // agent edited opened as a list of lines — the same defect the
      // attachment had, through the panel's other path.
      hasOriginal: true,
      originalKind: file.ext,
    }
  } catch {
    return null
  }
}

/** Drawn pages, with the stretch marked. It only exists for PDFs. */
export async function viewRender(
  sessionId: string,
  id: string,
  from: number,
  count: number,
  options: { scale?: number; includeText?: boolean; includeOutline?: boolean } = {},
): Promise<{
  total: number
  outline: PdfOutlineItem[]
  pages: { page: number; dataUrl: string; width: number; height: number; items: PdfTextItem[] }[]
} | null> {
  if (isSessionDoc(id)) return renderSessionPages(sessionId, id, from, count, options)

  const file = await mediaFile(id)
  if (!file || file.ext !== 'pdf') return null
  const start = Math.max(1, Math.round(from) || 1)
  const wanted: number[] = []
  for (let n = start; n < start + Math.max(1, count); n += 1) wanted.push(n)
  try {
    const bytes = await fsp.readFile(file.path)
    const rendered = await rasterizePdf(bytes, { ...options, pages: wanted })
    return {
      total: rendered.total,
      outline: rendered.outline,
      pages: rendered.pages.map((p) => ({
        page: p.pageNumber,
        dataUrl: `data:image/png;base64,${p.png.toString('base64')}`,
        width: p.width,
        height: p.height,
        items: p.items,
      })),
    }
  } catch {
    return null
  }
}

/** The .docx as a document in HTML, for the panel's Original mode. */
export async function viewHtml(sessionId: string, id: string): Promise<{ html: string } | null> {
  if (isSessionDoc(id)) return renderSessionDocx(sessionId, id)
  const file = await mediaFile(id)
  if (!file || file.ext !== 'docx') return null
  return docxFileToHtml(file.path)
}

export async function viewPrint(
  sessionId: string,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  if (isSessionDoc(id)) return printSessionDocument(sessionId, id)
  const file = await mediaFile(id)
  // PDF only: Chromium does not render .docx, and sending one to the print
  // window makes it DOWNLOAD the file instead of opening the dialog.
  if (!file || file.ext !== 'pdf') {
    return { ok: false, error: 'This document has no PDF version to print. Download the file.' }
  }
  const entry = await getMediaEntry(id)
  return printFile(file.path, entry?.name)
}

export async function viewExport(
  sessionId: string,
  id: string,
): Promise<{ ok: true; path: string } | { ok: false; canceled?: true; error?: string }> {
  if (isSessionDoc(id)) return exportSessionDocument(sessionId, id)

  const file = await mediaFile(id)
  if (!file) return { ok: false, error: 'Document not found.' }
  const entry = await getMediaEntry(id)
  const base = (entry?.name || 'document').slice(0, 60)
  const target = await saveExport(null, {
    fileName: `${base}.${file.ext}`,
    filters: [{ name: file.ext.toUpperCase(), extensions: [file.ext] }],
  })
  if (!target) return { ok: false, canceled: true }
  try {
    await fsp.copyFile(file.path, target)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
