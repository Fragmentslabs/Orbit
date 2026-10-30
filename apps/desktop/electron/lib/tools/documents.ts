import { tool } from 'ai'
import { z } from 'zod'
import { listMedia } from '../media'
import fsp from 'node:fs/promises'
import {
  documentHeader,
  documentKindOf,
  numberLines,
  pageLabel,
  pageLocator,
  pageWindow,
} from '../document-pages'
import { rasterizePdf } from '../pdf-raster'
import { resolveSafePath, type ToolContext } from './context'
import {
  listSessionDocuments,
  readSessionDocument,
  readSessionDocumentBytes,
  searchSessionDocuments,
} from '../session-documents'
import { describeMaterialsForAgent, listSessionMaterials } from '../session-materials'

/**
 * Query of the documents attached to the conversation (chat mode).
 *
 * Chat mode has neither `read` nor `grep`, so these tools are the equivalent
 * of what code mode gained on the repository files: locating the excerpt
 * and reading only it. The attachment now enters the message with an opening excerpt,
 * and the rest of the document stays here — charged per page read, not per turn.
 */

const DEFAULT_DOC_PAGES = 3
const MAX_DOC_PAGES = 20
const MAX_HITS = 40
/** Cap of the image sent to the model — above that the provider refuses it. */
const MAX_MODEL_IMAGE_BYTES = 300 * 1024

/**
 * The documents the AGENT wrote in this conversation, which are another list.
 *
 * A document produced here is neither an attachment nor a source — unless the user
 * promotes it —, so it does not appear in doc_list. And then the model listed the
 * sources, saw only the math proof and answered that the cited document did not
 * exist, with it saved an id away. The reminder is short on
 * purpose: what reads the content is read_document, not this list.
 */
async function writtenHere(sessionId: string): Promise<string | null> {
  const written = await listMedia({ kind: 'document', sessionId })
  if (written.length === 0) return null
  const names = written
    .slice(0, 10)
    .map((entry) => `${entry.id} (${entry.name ?? 'untitled'})`)
    .join(', ')
  return `Besides these, ${written.length} document(s) written by you in this conversation — use read_document/update_document with the id: ${names}.`
}

export function createDocumentTools(sessionId: string) {
  return {
    attachment_list: tool({
      description:
        'Lists the PHOTOS, GIFs, AUDIO and VIDEOS this conversation has at hand — what the user attached in the messages and what they put in the Sources tab (their own, and the ones shared by the sidebar folder) — each with its ref (img_…, aud_…, vdo_…), name and basic facts. ' +
        'They are NOT in your context: this is only the list. Read one when the request needs it (video_probe / transcribe / video_timeline accept the vdo_… and aud_… refs, describe_image the images) and put one INTO a piece or an edit with motion_asset({ ref, … }) only when you decide to use it. ' +
        'Use it when the user mentions material you cannot see in the conversation ("use the video I added", "the photo from the sources").',
      inputSchema: z.object({}),
      execute: async () => {
        const list = await listSessionMaterials(sessionId)
        if (list.shared.length + list.own.length === 0) return 'No photos, GIFs, audio or videos available in this conversation.'
        return describeMaterialsForAgent(list)
      },
    }),

    doc_list: tool({
      description:
        'Lists the documents (PDF, DOCX, spreadsheets) this conversation can read, with their id and page count. Two kinds: srcN are the SOURCES of the sidebar folder, declared by the user and shared with its other conversations (so they can be listed here without having been attached in this one); docN are the files attached in THIS conversation. Use it when you are unsure which document the user means, or to check what is available at all.',
      inputSchema: z.object({}),
      execute: async () => {
        const docs = await listSessionDocuments(sessionId)
        const written = await writtenHere(sessionId)
        if (docs.length === 0 && !written) return 'No documents available in this conversation.'
        const lines = docs.map((d) => {
          const unit = d.kind === 'spreadsheet' ? 'sheets' : d.kind === 'docx' ? 'blocks' : 'pages'
          const escopo = d.shared ? 'folder source' : 'attached in this conversation'
          return `${d.id}: ${d.filename} (${d.kind}, ${d.totalPages} ${unit}, ${escopo}${d.truncated ? ', truncated at the size limit' : ''})`
        })
        if (docs.length === 0) lines.push('No documents ATTACHED in this conversation.')
        if (written) lines.push(written)
        return lines.join('\n')
      },
    }),

    doc_search: tool({
      description:
        'Searches every document this conversation can read (the folder sources and the files attached here) and returns WHERE each match is (document, page) with the matching line — not the surrounding text. This is how you find the relevant part of a long document: search first, then doc_read around the page. Always prefer this over asking the user to paste an excerpt.',
      inputSchema: z.object({
        pattern: z
          .string()
          .describe('Regular expression (case-insensitive). Use alternation to cover synonyms.'),
        docId: z
          .string()
          .optional()
          .describe('Restrict the search to one document (id from doc_list). Omit to search all.'),
      }),
      execute: async ({ pattern, docId }) => {
        let regex: RegExp
        try {
          regex = new RegExp(pattern, 'i')
        } catch (err) {
          return `Invalid expression: ${(err as Error).message}`
        }
        const hits = await searchSessionDocuments(sessionId, regex, docId, MAX_HITS)
        if (hits.length === 0) {
          return 'No matches. Try other terms (synonyms, the term in another language) or doc_read to go through the document.'
        }
        const suffix = hits.length >= MAX_HITS ? '\n… (results truncated)' : ''
        return (
          hits
            .map((h) => {
              const where = pageLocator({ num: h.page, text: '', label: h.label }, h.kind)
              return `${h.docId} (${h.filename}):${where}L${h.lineNumber}: ${h.line}`
            })
            .join('\n') + suffix
        )
      },
    }),

    doc_read: tool({
      description:
        'Reads a stretch of a document, a few pages at a time (in a spreadsheet, each sheet is a page). Never returns the whole document: use doc_search to find the right page and read around it.',
      inputSchema: z.object({
        docId: z.string().describe('Document id (from doc_list or doc_search)'),
        offset: z.number().optional().describe('First page to read (1-indexed)'),
        limit: z.number().optional().describe(`How many pages (default ${DEFAULT_DOC_PAGES}, max ${MAX_DOC_PAGES})`),
      }),
      execute: async ({ docId, offset, limit }) => {
        const found = await readSessionDocument(sessionId, docId)
        if (!found) return `Document not found: ${docId}. Use doc_list to see the available ones.`
        const { doc, extracted } = found
        if (extracted.totalPages === 0) {
          return `<document name="${doc.filename}">\n(no extractable text — probably a scanned PDF. Use pdf_view_page to SEE the page: with no text layer, looking is the only way to read it.)\n</document>`
        }
        const { from, to, pages } = pageWindow(extracted, offset, limit, DEFAULT_DOC_PAGES, MAX_DOC_PAGES)
        // The lines come numbered so the citation can point at the excerpt, and not
        // only the page — it is the number from here that goes in the answer's link.
        const body = pages
          .map(
            (page) =>
              `--- ${pageLabel(page, extracted.kind)} ---\n${
                page.text ? numberLines(page.text) : '(page has no text)'
              }`,
          )
          .join('\n\n')
        return `${documentHeader(doc.filename, extracted, { from, to })}\n${body}\n</document>`
      },
    }),
  }
}

/**
 * Seeing a PDF page as an IMAGE.
 *
 * It exists for two reasons the extracted text does not cover:
 *
 * 1. A scanned PDF has no text layer — doc_read returns empty, and the
 *    only way to read is for the model to look at the page.
 * 2. LAYOUT questions (where the field is, how it is laid out, whether the stamp
 *    is on the right page) are not answered by the text.
 *
 * It rasterizes in a hidden window (see pdf-raster.ts) — without depending on
 * LibreOffice or Poppler installed on the user's machine.
 */
export function createPdfViewTool(sessionId: string, ctx: ToolContext | null, modelVision: boolean) {
  return tool({
    description:
      'Renders a page of a PDF as an image and looks at it. Use it only when text cannot answer: doc_read returns no text (a scanned PDF has no text layer, so reading it means SEEING it), or the question is about layout rather than wording. To check a document you produced, read it back as text (doc_read) — do not render pages to prove it is done. Source: docId for an attached PDF, or filePath for one in the working folder.',
    inputSchema: z.object({
      docId: z.string().optional().describe('Attached document id (from doc_list)'),
      filePath: z.string().optional().describe('PDF in the working folder (code mode)'),
      page: z.number().optional().describe('Page to render (1-indexed, default 1)'),
      scale: z.number().optional().describe('Zoom, 1-3 (default 1.5). Raise it to read small print.'),
    }),
    execute: async ({ docId, filePath, page, scale }) => {
      if (!modelVision) {
        return 'This model cannot see images, so rendering the page would not help. Use doc_read/doc_search for the text, or ask the user to switch to a model with vision.'
      }

      let bytes: Buffer
      let label: string
      if (filePath) {
        if (!ctx) return 'filePath only works in code mode. Use docId.'
        if (documentKindOf(filePath) !== 'pdf') return `Not a PDF: ${filePath}.`
        try {
          bytes = await fsp.readFile(resolveSafePath(ctx, filePath))
        } catch (err) {
          return `Could not open ${filePath}: ${(err as Error).message}`
        }
        label = filePath
      } else if (docId) {
        const found = await readSessionDocument(sessionId, docId)
        if (!found) return `Document not found: ${docId}.`
        if (found.doc.kind !== 'pdf') {
          return `${docId} (${found.doc.filename}) is not a PDF — it is ${found.doc.kind}. Use doc_read.`
        }
        const stored = await readSessionDocumentBytes(sessionId, docId)
        if (!stored) {
          return `The original file of ${found.doc.filename} was not kept (attached before this feature existed). Attach it again to be able to see the pages.`
        }
        bytes = stored
        label = found.doc.filename
      } else {
        return 'Provide docId (attached document) or filePath (PDF in the working folder).'
      }

      const wanted = Math.max(1, Math.round(page ?? 1))
      try {
        const rendered = await rasterizePdf(bytes, { pages: [wanted], scale })
        const first = rendered.pages[0]
        if (!first) {
          return `Page ${wanted} does not exist in ${label} — the document has ${rendered.total}.`
        }

        // Above the cap the provider rejects the image; reducing the scale is the way out
        // the model has, so the message says that instead of just failing.
        if (first.png.length > MAX_MODEL_IMAGE_BYTES) {
          return `Rendered page ${wanted} is ${Math.round(first.png.length / 1024)}KB, above the ${Math.round(MAX_MODEL_IMAGE_BYTES / 1024)}KB limit. Retry with a smaller scale (e.g. 1).`
        }
        return {
          type: 'content' as const,
          value: [
            { type: 'text' as const, text: `${label} — page ${first.pageNumber} (${first.width}×${first.height})` },
            { type: 'image-data' as const, data: first.png.toString('base64'), mediaType: 'image/png' },
          ],
        }
      } catch (err) {
        return `Failed to render ${label}: ${(err as Error).message}`
      }
    },
  })
}
