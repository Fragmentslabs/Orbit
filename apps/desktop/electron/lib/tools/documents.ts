import { tool } from 'ai'
import { z } from 'zod'
import { documentHeader, pageLabel, pageWindow } from '../document-pages'
import {
  listSessionDocuments,
  readSessionDocument,
  searchSessionDocuments,
} from '../session-documents'

/**
 * Consulta aos documentos anexados na conversa (modo chat).
 *
 * O modo chat não tem `read` nem `grep`, então estas tools são o equivalente
 * do que o modo código ganhou nos arquivos do repositório: localizar o trecho
 * e ler só ele. O anexo passa a entrar na mensagem com um trecho de abertura,
 * e o resto do documento fica aqui — cobrado por página lida, não por turno.
 */

const DEFAULT_DOC_PAGES = 3
const MAX_DOC_PAGES = 20
const MAX_HITS = 40

export function createDocumentTools(sessionId: string) {
  return {
    doc_list: tool({
      description:
        'Lists the documents (PDF, DOCX, spreadsheets) attached to this conversation, with their id and page count. Use it when you are unsure which document the user means, or to check whether something was attached earlier in the conversation.',
      inputSchema: z.object({}),
      execute: async () => {
        const docs = await listSessionDocuments(sessionId)
        if (docs.length === 0) return 'Nenhum documento anexado nesta conversa.'
        return docs
          .map((d) => {
            const unit = d.kind === 'spreadsheet' ? 'abas' : d.kind === 'docx' ? 'blocos' : 'páginas'
            return `${d.id}: ${d.filename} (${d.kind}, ${d.totalPages} ${unit}${d.truncated ? ', cortado no limite de tamanho' : ''})`
          })
          .join('\n')
      },
    }),

    doc_search: tool({
      description:
        'Searches the documents attached to this conversation and returns WHERE each match is (document, page) with the matching line — not the surrounding text. This is how you find the relevant part of a long document: search first, then doc_read around the page. Always prefer this over asking the user to paste an excerpt.',
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
          return `Expressão inválida: ${(err as Error).message}`
        }
        const hits = await searchSessionDocuments(sessionId, regex, docId, MAX_HITS)
        if (hits.length === 0) {
          return 'Nenhuma ocorrência. Tente outros termos (sinônimos, o termo em outro idioma) ou doc_read para percorrer o documento.'
        }
        const suffix = hits.length >= MAX_HITS ? '\n… (resultados truncados)' : ''
        return (
          hits.map((h) => `${h.docId} (${h.filename}):p${h.page}: ${h.line}`).join('\n') + suffix
        )
      },
    }),

    doc_read: tool({
      description:
        'Reads a stretch of an attached document, a few pages at a time (in a spreadsheet, each sheet is a page). Never returns the whole document: use doc_search to find the right page and read around it.',
      inputSchema: z.object({
        docId: z.string().describe('Document id (from doc_list or doc_search)'),
        offset: z.number().optional().describe('First page to read (1-indexed)'),
        limit: z.number().optional().describe(`How many pages (default ${DEFAULT_DOC_PAGES}, max ${MAX_DOC_PAGES})`),
      }),
      execute: async ({ docId, offset, limit }) => {
        const found = await readSessionDocument(sessionId, docId)
        if (!found) return `Documento não encontrado: ${docId}. Use doc_list para ver os disponíveis.`
        const { doc, extracted } = found
        if (extracted.totalPages === 0) {
          return `<document name="${doc.filename}">\n(nenhum texto extraível — provavelmente um PDF digitalizado, sem camada de texto)\n</document>`
        }
        const { from, to, pages } = pageWindow(extracted, offset, limit, DEFAULT_DOC_PAGES, MAX_DOC_PAGES)
        const body = pages
          .map((page) => `--- ${pageLabel(page, extracted.kind)} ---\n${page.text || '(página sem texto)'}`)
          .join('\n\n')
        return `${documentHeader(doc.filename, extracted, { from, to })}\n${body}\n</document>`
      },
    }),
  }
}
