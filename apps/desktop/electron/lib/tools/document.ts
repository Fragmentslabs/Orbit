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

/**
 * Documentos entregáveis: relatório, proposta, ata, especificação.
 *
 * O agente escreve MARKDOWN e o Orbit renderiza para PDF e/ou DOCX. Markdown
 * é o fonte porque HTML→DOCX é intratável (CSS arbitrário não tem equivalente
 * em OOXML) e porque é o que o modelo escreve melhor. Artefato HTML continua
 * sendo o caminho de dashboard e protótipo — documento é outro objeto, com
 * outro destino: imprimir, anexar em e-mail, mandar para um cliente.
 *
 * Guardar o fonte é o que faz "modificar" existir de verdade: editar um PDF
 * ou preservar a formatação de um .docx é intratável; reescrever o Markdown e
 * renderizar de novo é exato.
 *
 * Escopo: o documento nasce marcado com a pasta de trabalho (modo código) ou
 * a pasta da sidebar (modo chat), então list_documents reencontra o que foi
 * produzido no MESMO projeto, em qualquer conversa anterior.
 */

const MAX_MARKDOWN_BYTES = 1024 * 1024

const formatSchema = z
  .array(z.enum(['pdf', 'docx']))
  .optional()
  .describe('Output formats (default: pdf). Use docx when the user will edit the file.')

const MARKDOWN_HELP =
  'Markdown: # ## ### for headings, - or 1. for lists, | tables |, > quote, **bold**, *italic*, `code`, --- for a rule, and \\pagebreak on its own line to force a page break.'

export interface DocumentToolScope {
  sessionId: string
  /** Pasta de trabalho (modo código) — escopo de projeto do documento. */
  directory?: string
}

/**
 * Pasta da sidebar em que a sessão está. Resolvida aqui, lendo a sessão
 * persistida, e não recebida no SendMessageInput: o folderId muda quando o
 * usuário arrasta o chat entre pastas, e o input é montado em vários lugares
 * (envio normal, loop, rotinas, esteira) — qualquer um deles esqueceria de
 * preencher. Ler no momento do uso sempre reflete o estado atual.
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
 * Filtro da listagem. "project" é o escopo que interessa no modo código: a
 * pasta de trabalho, que reúne o que foi produzido sobre o MESMO repositório
 * em qualquer conversa — não só nesta. Sem pasta e sem agrupamento (chat
 * solto), cai para a sessão, que é o único escopo que existe ali.
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

export function createDocumentAuthoringTools(scope: DocumentToolScope) {
  return {
    create_document: tool({
      description: `Writes a deliverable document (report, proposal, minutes, specification) and renders it to PDF and/or DOCX, showing it in your response and saving it to the media gallery. Use it when the user asks for a document, a report or "a PDF/Word" of something — not for a quick answer that belongs in the chat, and not for source code. ${MARKDOWN_HELP}`,
      inputSchema: z.object({
        title: z.string().min(1).max(150).describe('Document title, also used as the file name'),
        markdown: z.string().min(1).describe('Full document content in Markdown'),
        formats: formatSchema,
      }),
      execute: async ({ title, markdown, formats }) => {
        if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
          return `Documento muito grande (limite de ${Math.round(MAX_MARKDOWN_BYTES / 1024)}KB de Markdown).`
        }
        const wanted: DocumentFormat[] = formats?.length ? formats : ['pdf']
        const ref = await saveDocument(markdown, wanted, {
          title,
          sessionId: scope.sessionId,
          directory: scope.directory,
          folderId: await resolveFolderId(scope.sessionId),
        })
        if (ref.formats.length === 0) {
          return `O documento "${title}" foi salvo, mas nenhuma renderização foi gerada. Tente novamente; se persistir, avise o usuário.`
        }
        return {
          documentId: ref.id,
          title: ref.title,
          previewUrl: ref.previewUrl,
          formats: ref.formats,
          thumb: ref.thumb,
          revision: ref.revision,
          message: `Documento criado em ${ref.formats.join(' e ')} — o usuário já o vê na resposta e ele está na galeria. Para alterá-lo, use update_document com este documentId.`,
        }
      },
    }),

    update_document: tool({
      description: `Rewrites a document you created before, keeping its place in the gallery. Pass the FULL new Markdown — it replaces the source and the file is rendered again. Read the current source with read_document first when you are changing only part of it. ${MARKDOWN_HELP}`,
      inputSchema: z.object({
        documentId: z.string().describe('Document id (doc_....md), from create_document or list_documents'),
        markdown: z.string().min(1).describe('The complete new Markdown'),
        title: z.string().max(150).optional(),
        formats: formatSchema,
      }),
      execute: async ({ documentId, markdown, title, formats }) => {
        if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
          return `Documento muito grande (limite de ${Math.round(MAX_MARKDOWN_BYTES / 1024)}KB de Markdown).`
        }
        const ref = await updateDocument(documentId, markdown, { title, formats })
        if (!ref) return `Documento não encontrado: ${documentId}. Use list_documents para ver os disponíveis.`
        return {
          documentId: ref.id,
          title: ref.title,
          previewUrl: ref.previewUrl,
          formats: ref.formats,
          thumb: ref.thumb,
          revision: ref.revision,
          message: 'Documento atualizado — o usuário já vê a nova versão.',
        }
      },
    }),

    read_document: tool({
      description:
        'Returns the Markdown source of a document, so you can change part of it without rewriting from memory. Always read before a partial edit — rewriting from memory silently drops whatever you had forgotten.',
      inputSchema: z.object({
        documentId: z.string().describe('Document id (doc_....md)'),
      }),
      execute: async ({ documentId }) => {
        const found = await readDocumentSource(documentId)
        if (!found) return `Documento não encontrado: ${documentId}.`
        return `<document id="${documentId}" title="${found.entry.name ?? ''}">\n${found.markdown}\n</document>`
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
        if (docs.length === 0) return 'Nenhum documento encontrado neste escopo.'
        return docs
          .map((d) => {
            const when = new Date(d.createdAt).toISOString().slice(0, 10)
            const formats = (d.formats ?? []).join('/') || 'sem renderização'
            const rev = (d.revision ?? 1) > 1 ? `, v${d.revision}` : ''
            return `${d.id}: ${d.name ?? '(sem título)'} (${formats}, ${when}${rev})`
          })
          .join('\n')
      },
    }),
  }
}
