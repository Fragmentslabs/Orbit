import { tool } from 'ai'
import { z } from 'zod'
import {
  listMedia,
  readDocumentSource,
  saveDocument,
  updateDocument,
} from '../media'
import type { DocumentFormat, MediaFilter } from '@shared/media'
import { StorageKeys, type SessionInfo } from '@shared/chat'
import { readJson } from '../storage'
import { findFont } from '../fonts/store'
import type { DocumentStyle } from '../document-render'
import { underscoreBlankWarning } from '../markdown-blanks'

/**
 * Deliverable documents: report, proposal, minutes, specification.
 *
 * The agent writes MARKDOWN, and that is what the document IS — not an intermediate
 * step. Markdown is the source because HTML→DOCX is intractable (arbitrary CSS
 * has no equivalent in OOXML) and because it is what the model writes
 * best. The HTML artifact remains the path for dashboards and prototypes —
 * a document is another object, made to be read, edited and, when it is the
 * case, printed or sent.
 *
 * PDF and DOCX are OUTPUTS, not the product: without `formats`, nothing is rendered at
 * creation and the user downloads whichever format they want later. Rendering by
 * default cost a Chromium window on every document, including the ones that
 * never become a file — which are the majority, because the normal thing is to read there and
 * move on.
 *
 * Keeping the source is what makes "modify" really exist: editing a PDF
 * or preserving a .docx's formatting is intractable; rewriting the Markdown and
 * rendering again is exact.
 *
 * Scope: the document is born tagged with the working folder (code mode) or
 * the sidebar folder (chat mode), so list_documents finds again what was
 * produced in the SAME project, in any earlier conversation.
 */

const MAX_MARKDOWN_BYTES = 1024 * 1024

const formatSchema = z
  .array(z.enum(['pdf', 'docx']))
  .optional()
  .describe(
    'Files to render immediately. OMIT IT by default: the document lives in the conversation as Markdown and the user downloads PDF or DOCX from the card whenever they want. Pass it ONLY when the user explicitly asked for "a PDF" or "a Word file", or said they are going to print, e-mail or send the file.',
  )

const MARKDOWN_HELP =
  'Markdown: # ## ### for headings, - or 1. for lists, | tables | (the divider row sets column alignment: |:---|:---:|---:|), > quote, **bold**, *italic*, `code`, ``` fenced blocks for code (write the language right after the opening fence), --- for a rule, <br> for a blank line, and \\pagebreak on its own line to force a page break. Diagrams: a ```mermaid fenced block (flowchart, sequenceDiagram, classDiagram, erDiagram, stateDiagram-v2, gantt, pie, mindmap, timeline) is drawn as a diagram on screen, in the PDF and in the DOCX — use it when a flow, architecture, schema or timeline reads better as a picture than as prose. Keep node labels short and quote any label with parentheses or punctuation (A["Login (OAuth)"]); a diagram with invalid syntax falls back to showing its source as code.'

/**
 * Style exposed as a CLOSED set of options, and not free CSS: everything
 * here has to exist in OOXML too, otherwise the PDF would come out pretty and the .docx
 * broken — and the user would only find out when opening the file in Word.
 */
const styleSchema = z
  .object({
    fontFamily: z
      .string()
      .optional()
      .describe('ONE font name, e.g. "Georgia", "Calibri", "Arial", or a family installed in the Orbit library with font_use ("Inter", "Playfair Display") - not a CSS stack: "Inter, sans-serif" keeps only "Inter". A library family is embedded in the PDF, so the file opens right on any machine; the .docx carries only the name, so whoever opens it needs the font installed.'),
    fontSize: z.number().optional().describe('Body size in points (7-18, default 11). Headings scale with it.'),
    accentColor: z
      .string()
      .optional()
      .describe('Hex color for headings, table header and rules, e.g. "#1F4E79".'),
    marginCm: z.number().optional().describe('Page margin in centimetres (0.5-5, default 2.5).'),
    columns: z.number().optional().describe('Text columns for the WHOLE document (1-3, default 1).'),
    align: z.enum(['left', 'justify']).optional().describe('Body text alignment (default justify).'),
  })
  .optional()
  .describe('Visual customization. Applies to both PDF and DOCX.')

export interface DocumentToolScope {
  sessionId: string
  /** Working folder (code mode) — the document's project scope. */
  directory?: string
}

/**
 * Sidebar folder the session belongs to. Resolved here, by reading the
 * persisted session, instead of being received in SendMessageInput: the
 * folderId changes when the user drags the chat between folders, and the input
 * is assembled in several places (normal send, loop, routines, pipeline) — any
 * of them would forget to fill it in. Reading it at the point of use always
 * reflects the current state.
 */
async function resolveFolderId(sessionId: string): Promise<string | undefined> {
  try {
    const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
    return session?.folderId ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Listing filter. "project" is the scope that matters in code mode: the
 * working folder, which gathers what was produced over the SAME repository
 * in any conversation — not only this one. With no folder and no grouping (a loose
 * chat), it falls back to the session, which is the only scope that exists there.
 */
function documentFilter(
  scope: DocumentToolScope,
  wanted: 'project' | 'session' | 'all',
  folderId: string | undefined,
): MediaFilter {
  const kind = 'document' as const
  if (wanted === 'all') return { kind }
  if (wanted === 'session') return { kind, sessionId: scope.sessionId }
  if (scope.directory) return { kind, directory: scope.directory }
  if (folderId) return { kind, folderId }
  return { kind, sessionId: scope.sessionId }
}

/**
 * The PDF embeds the installed font; the .docx does not - OOXML would require embedding the TTF,
 * which the library does not keep. The warning in the response is what keeps the user from
 * finding that out only when opening the file in Word.
 */
async function docxFontWarning(style?: DocumentStyle): Promise<string> {
  const first = (style?.fontFamily ?? '').split(',')[0].replace(/["']/g, '').trim()
  if (!first) return ''
  const font = await findFont(first)
  if (!font) return ''
  return `The .docx names "${font.family}" but Word only renders it with the font installed on that machine; the PDF has it embedded.`
}
export function createDocumentAuthoringTools(scope: DocumentToolScope) {
  return {
    create_document: tool({
      description: `Writes a document (report, proposal, minutes, specification, documentation) in Markdown and shows it in your response, saved to the media gallery. Use it when the user asks for a document, a report, documentation, or "a PDF/Word" of something — not for a quick answer that belongs in the chat, and not for source code. The document is Markdown: the user reads it in the conversation and can download it as PDF or DOCX from the card, so do NOT pass \`formats\` unless they asked for a file. ${MARKDOWN_HELP}`,
      inputSchema: z.object({
        title: z.string().min(1).max(150).describe('Document title, also used as the file name'),
        markdown: z.string().min(1).describe('Full document content in Markdown'),
        formats: formatSchema,
        style: styleSchema,
      }),
      execute: async ({ title, markdown, formats, style }) => {
        if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
          return `Document too large (limit ${Math.round(MAX_MARKDOWN_BYTES / 1024)}KB of Markdown).`
        }
        // Without `formats`, nothing is rendered: the document is born in Markdown and the
        // user chooses the format when downloading.
        const wanted: DocumentFormat[] = formats ?? []
        const ref = await saveDocument(markdown, wanted, {
          title,
          style,
          sessionId: scope.sessionId,
          directory: scope.directory,
          folderId: await resolveFolderId(scope.sessionId),
        })
        // It is only a failure when there was something to render: an empty `formats` is the
        // normal case, and the Markdown document is already whole in the conversation.
        if (wanted.length > 0 && ref.formats.length === 0) {
          return `The document "${title}" was saved, but no rendering was generated. Try again; if it persists, tell the user.`
        }
        return {
          documentId: ref.id,
          title: ref.title,
          previewUrl: ref.previewUrl,
          formats: ref.formats,
          thumb: ref.thumb,
          revision: ref.revision,
          message: [
            ref.formats.length > 0
              ? `Document created as ${ref.formats.join(' and ')} — the user already sees it in the reply and it is in the gallery. To change it, use update_document with this documentId.`
              : 'Document created — the user already sees it in the reply and can download it as PDF or DOCX from the card whenever they want. To change it, use update_document with this documentId.',
            // The document was written as it came; what comes back is the warning that
            // a line will not arrive like that on the reader's screen.
            await docxFontWarning(style),
            underscoreBlankWarning(markdown),
          ]
            .filter(Boolean)
            .join(' '),
        }
      },
    }),

    update_document: tool({
      description: `Rewrites a document you created before, keeping its place in the gallery. Pass the FULL new Markdown — it REPLACES the source, so anything you leave out is gone. Read the current source with read_document first and pass back the revision it reported as baseRevision: the user can be editing the same document in the side panel, and that is what stops you from overwriting their work. ${MARKDOWN_HELP}`,
      inputSchema: z.object({
        documentId: z.string().describe('Document id (doc_....md), from create_document or list_documents'),
        markdown: z.string().min(1).describe('The complete new Markdown'),
        baseRevision: z
          .number()
          .optional()
          .describe(
            'The revision read_document reported for the version this rewrite is based on. Always pass it when you read the document first. The write is refused if the document changed in the meantime.',
          ),
        title: z.string().max(150).optional(),
        formats: formatSchema,
        style: styleSchema,
      }),
      execute: async ({ documentId, markdown, baseRevision, title, formats, style }) => {
        if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
          return `Document too large (limit ${Math.round(MAX_MARKDOWN_BYTES / 1024)}KB of Markdown).`
        }
        const result = await updateDocument(documentId, markdown, {
          title,
          formats,
          style,
          baseRevision,
        })
        if (!result.ok) {
          if (result.reason === 'notFound') {
            return `Document not found: ${documentId}. Use list_documents to see the available ones.`
          }
          // Nothing was written. Repeating the same rewrite would repeat the error: the
          // path is to re-read and re-apply the change over the new version.
          return `The document changed since the version you based your edit on — the user probably edited it in the panel (it is now at revision ${result.revision}). NOTHING was saved. Call read_document, reapply your change on the text it returns and call update_document again with the baseRevision that read reports. Do not repeat the same rewrite: it would erase the user's edit.`
        }
        const ref = result.ref
        return {
          documentId: ref.id,
          title: ref.title,
          previewUrl: ref.previewUrl,
          formats: ref.formats,
          thumb: ref.thumb,
          revision: ref.revision,
          message: ['Document updated — the user already sees the new version.', await docxFontWarning(style),
              underscoreBlankWarning(markdown)]
            .filter(Boolean)
            .join(' '),
        }
      },
    }),

    read_document: tool({
      description:
        'Returns the Markdown source of a document and the revision it is at. Always read before editing: rewriting from memory silently drops whatever you had forgotten, and the user may have changed the document in the side panel since you last saw it. Pass the revision back as baseRevision in update_document.',
      inputSchema: z.object({
        documentId: z.string().describe('Document id (doc_....md)'),
      }),
      execute: async ({ documentId }) => {
        const found = await readDocumentSource(documentId)
        if (!found) return `Document not found: ${documentId}.`
        // The revision comes back in the envelope itself: it is what update_document asks
        // back to prove that the rewrite started from THIS version.
        const revision = found.entry.revision ?? 1
        return `<document id="${documentId}" title="${found.entry.name ?? ''}" revision="${revision}">\n${found.markdown}\n</document>\nWhen rewriting this document, pass baseRevision=${revision}.`
      },
    }),

    list_documents: tool({
      description:
        'Lists documents already produced, so you can update one instead of creating a near-duplicate. By default it lists the ones from THIS project (the working folder) when there is one, which includes documents made in other conversations about the same repository; pass scope "session" for only this conversation, or "all" for everything.',
      inputSchema: z.object({
        scope: z
          .enum(['project', 'session', 'all'])
          .optional()
          .describe('Default: project when there is a working folder, otherwise session'),
      }),
      execute: async ({ scope: wanted }) => {
        const folderId = scope.directory ? undefined : await resolveFolderId(scope.sessionId)
        const docs = await listMedia(documentFilter(scope, wanted ?? 'project', folderId))
        if (docs.length === 0) return 'No documents found in this scope.'
        return docs
          .map((d) => {
            const when = new Date(d.createdAt).toISOString().slice(0, 10)
            const formats = (d.formats ?? []).join('/') || 'not rendered'
            const rev = (d.revision ?? 1) > 1 ? `, v${d.revision}` : ''
            return `${d.id}: ${d.name ?? '(untitled)'} (${formats}, ${when}${rev})`
          })
          .join('\n')
      },
    }),
  }
}
