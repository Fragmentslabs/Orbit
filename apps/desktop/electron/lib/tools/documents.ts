import { tool } from 'ai'
import { z } from 'zod'
import fsp from 'node:fs/promises'
import { documentHeader, documentKindOf, pageLabel, pageLocator, pageWindow } from '../document-pages'
import { rasterizePdf } from '../pdf-raster'
import { resolveSafePath, type ToolContext } from './context'
import {
  listSessionDocuments,
  readSessionDocument,
  readSessionDocumentBytes,
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
/** Teto da imagem enviada ao modelo — acima disso o provedor recusa. */
const MAX_MODEL_IMAGE_BYTES = 300 * 1024

export function createDocumentTools(sessionId: string) {
  return {
    doc_list: tool({
      description:
        'Lists the documents (PDF, DOCX, spreadsheets) this conversation can read, with their id and page count. Two kinds: srcN are the SOURCES of the sidebar folder, declared by the user and shared with its other conversations (so they can be listed here without having been attached in this one); docN are the files attached in THIS conversation. Use it when you are unsure which document the user means, or to check what is available at all.',
      inputSchema: z.object({}),
      execute: async () => {
        const docs = await listSessionDocuments(sessionId)
        if (docs.length === 0) return 'Nenhum documento disponível nesta conversa.'
        return docs
          .map((d) => {
            const unit = d.kind === 'spreadsheet' ? 'abas' : d.kind === 'docx' ? 'blocos' : 'páginas'
            const escopo = d.shared ? 'fonte da pasta' : 'anexo desta conversa'
            return `${d.id}: ${d.filename} (${d.kind}, ${d.totalPages} ${unit}, ${escopo}${d.truncated ? ', cortado no limite de tamanho' : ''})`
          })
          .join('\n')
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
          return `Expressão inválida: ${(err as Error).message}`
        }
        const hits = await searchSessionDocuments(sessionId, regex, docId, MAX_HITS)
        if (hits.length === 0) {
          return 'Nenhuma ocorrência. Tente outros termos (sinônimos, o termo em outro idioma) ou doc_read para percorrer o documento.'
        }
        const suffix = hits.length >= MAX_HITS ? '\n… (resultados truncados)' : ''
        return (
          hits
            .map((h) => {
              const where = pageLocator({ num: h.page, text: '', label: h.label }, h.kind)
              return `${h.docId} (${h.filename}):${where}: ${h.line}`
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
        if (!found) return `Documento não encontrado: ${docId}. Use doc_list para ver os disponíveis.`
        const { doc, extracted } = found
        if (extracted.totalPages === 0) {
          return `<document name="${doc.filename}">\n(nenhum texto extraível — provavelmente um PDF digitalizado. Use pdf_view_page para VER a página: sem camada de texto, olhar é a única forma de ler.)\n</document>`
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

/**
 * Ver uma página do PDF como IMAGEM.
 *
 * Existe por dois motivos que o texto extraído não cobre:
 *
 * 1. PDF digitalizado não tem camada de texto — doc_read devolve vazio, e a
 *    única forma de ler é o modelo olhar a página.
 * 2. Perguntas de LAYOUT (onde fica o campo, como está diagramado, o carimbo
 *    está na página certa) não se respondem pelo texto.
 *
 * Rasteriza numa janela oculta (ver pdf-raster.ts) — sem depender de
 * LibreOffice ou Poppler instalados na máquina do usuário.
 */
export function createPdfViewTool(sessionId: string, ctx: ToolContext | null, modelVision: boolean) {
  return tool({
    description:
      'Renders a page of a PDF as an image and looks at it. Use it when doc_read returns no text (a scanned PDF has no text layer, so reading it means SEEING it), when the question is about layout rather than wording, or to check a document you produced. Source: docId for an attached PDF, or filePath for one in the working folder.',
    inputSchema: z.object({
      docId: z.string().optional().describe('Attached document id (from doc_list)'),
      filePath: z.string().optional().describe('PDF in the working folder (code mode)'),
      page: z.number().optional().describe('Page to render (1-indexed, default 1)'),
      scale: z.number().optional().describe('Zoom, 1-3 (default 1.5). Raise it to read small print.'),
    }),
    execute: async ({ docId, filePath, page, scale }) => {
      if (!modelVision) {
        return 'Este modelo não enxerga imagens, então renderizar a página não ajudaria. Use doc_read/doc_search para o texto, ou peça ao usuário para trocar para um modelo com visão.'
      }

      let bytes: Buffer
      let label: string
      if (filePath) {
        if (!ctx) return 'filePath só funciona no modo código. Use docId.'
        if (documentKindOf(filePath) !== 'pdf') return `Não é um PDF: ${filePath}.`
        try {
          bytes = await fsp.readFile(resolveSafePath(ctx, filePath))
        } catch (err) {
          return `Não foi possível abrir ${filePath}: ${(err as Error).message}`
        }
        label = filePath
      } else if (docId) {
        const found = await readSessionDocument(sessionId, docId)
        if (!found) return `Documento não encontrado: ${docId}.`
        if (found.doc.kind !== 'pdf') {
          return `${docId} (${found.doc.filename}) não é PDF — é ${found.doc.kind}. Use doc_read.`
        }
        const stored = await readSessionDocumentBytes(sessionId, docId)
        if (!stored) {
          return `O arquivo original de ${found.doc.filename} não foi preservado (anexo anterior a este suporte). Anexe de novo para poder ver as páginas.`
        }
        bytes = stored
        label = found.doc.filename
      } else {
        return 'Informe docId (documento anexado) ou filePath (PDF da pasta de trabalho).'
      }

      const wanted = Math.max(1, Math.round(page ?? 1))
      try {
        const rendered = await rasterizePdf(bytes, { pages: [wanted], scale })
        const first = rendered.pages[0]
        if (!first) {
          return `Página ${wanted} não existe em ${label} — o documento tem ${rendered.total}.`
        }

        // Acima do teto o provedor rejeita a imagem; reduzir a escala é a saída
        // que o modelo tem, então a mensagem diz isso em vez de só falhar.
        if (first.png.length > MAX_MODEL_IMAGE_BYTES) {
          return `A página ${wanted} renderizada ficou com ${Math.round(first.png.length / 1024)}KB, acima do limite de ${Math.round(MAX_MODEL_IMAGE_BYTES / 1024)}KB. Repita com scale menor (ex.: 1).`
        }
        return {
          type: 'content' as const,
          value: [
            { type: 'text' as const, text: `${label} — página ${first.pageNumber} (${first.width}×${first.height})` },
            { type: 'image-data' as const, data: first.png.toString('base64'), mediaType: 'image/png' },
          ],
        }
      } catch (err) {
        return `Erro ao renderizar ${label}: ${(err as Error).message}`
      }
    },
  })
}
