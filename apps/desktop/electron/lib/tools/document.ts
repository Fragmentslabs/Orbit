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
 * O agente escreve MARKDOWN, e é isso que o documento É — não um passo
 * intermediário. Markdown é o fonte porque HTML→DOCX é intratável (CSS
 * arbitrário não tem equivalente em OOXML) e porque é o que o modelo escreve
 * melhor. Artefato HTML continua sendo o caminho de dashboard e protótipo —
 * documento é outro objeto, feito para ser lido, editado e, quando for o
 * caso, impresso ou enviado.
 *
 * PDF e DOCX são SAÍDAS, não o produto: sem `formats`, nada é renderizado na
 * criação e o usuário baixa o formato que quiser depois. Renderizar por
 * padrão custava uma janela do Chromium em todo documento, inclusive nos que
 * nunca viram arquivo — que são a maioria, porque o normal é ler ali e
 * seguir.
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
  .describe(
    'Files to render immediately. OMIT IT by default: the document lives in the conversation as Markdown and the user downloads PDF or DOCX from the card whenever they want. Pass it ONLY when the user explicitly asked for "a PDF" or "a Word file", or said they are going to print, e-mail or send the file.',
  )

const MARKDOWN_HELP =
  'Markdown: # ## ### for headings, - or 1. for lists, | tables | (the divider row sets column alignment: |:---|:---:|---:|), > quote, **bold**, *italic*, `code`, ``` fenced blocks for code (write the language right after the opening fence), --- for a rule, <br> for a blank line, and \\pagebreak on its own line to force a page break.'

/**
 * Estilo exposto como um conjunto FECHADO de opções, e não CSS livre: tudo
 * aqui tem que existir também em OOXML, senão o PDF sairia bonito e o .docx
 * quebrado — e o usuário só descobriria ao abrir o arquivo no Word.
 */
const styleSchema = z
  .object({
    fontFamily: z
      .string()
      .optional()
      .describe('ONE font name, e.g. "Georgia", "Calibri", "Arial", "Courier New" — not a CSS stack: "Inter, sans-serif" keeps only "Inter". It must exist on the reader\'s machine; unknown names fall back to a generic family.'),
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
      description: `Writes a document (report, proposal, minutes, specification, documentation) in Markdown and shows it in your response, saved to the media gallery. Use it when the user asks for a document, a report, documentation, or "a PDF/Word" of something — not for a quick answer that belongs in the chat, and not for source code. The document is Markdown: the user reads it in the conversation and can download it as PDF or DOCX from the card, so do NOT pass \`formats\` unless they asked for a file. ${MARKDOWN_HELP}`,
      inputSchema: z.object({
        title: z.string().min(1).max(150).describe('Document title, also used as the file name'),
        markdown: z.string().min(1).describe('Full document content in Markdown'),
        formats: formatSchema,
        style: styleSchema,
      }),
      execute: async ({ title, markdown, formats, style }) => {
        if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
          return `Documento muito grande (limite de ${Math.round(MAX_MARKDOWN_BYTES / 1024)}KB de Markdown).`
        }
        // Sem `formats`, nada é renderizado: o documento nasce em Markdown e o
        // usuário escolhe o formato na hora de baixar.
        const wanted: DocumentFormat[] = formats ?? []
        const ref = await saveDocument(markdown, wanted, {
          title,
          style,
          sessionId: scope.sessionId,
          directory: scope.directory,
          folderId: await resolveFolderId(scope.sessionId),
        })
        // Só é falha quando havia o que renderizar: `formats` vazio é o caso
        // normal, e o documento em Markdown já está inteiro na conversa.
        if (wanted.length > 0 && ref.formats.length === 0) {
          return `O documento "${title}" foi salvo, mas nenhuma renderização foi gerada. Tente novamente; se persistir, avise o usuário.`
        }
        return {
          documentId: ref.id,
          title: ref.title,
          previewUrl: ref.previewUrl,
          formats: ref.formats,
          thumb: ref.thumb,
          revision: ref.revision,
          message:
            ref.formats.length > 0
              ? `Documento criado em ${ref.formats.join(' e ')} — o usuário já o vê na resposta e ele está na galeria. Para alterá-lo, use update_document com este documentId.`
              : 'Documento criado — o usuário já o vê na resposta e pode baixá-lo em PDF ou DOCX pelo próprio card quando quiser. Para alterá-lo, use update_document com este documentId.',
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
          return `Documento muito grande (limite de ${Math.round(MAX_MARKDOWN_BYTES / 1024)}KB de Markdown).`
        }
        const result = await updateDocument(documentId, markdown, {
          title,
          formats,
          style,
          baseRevision,
        })
        if (!result.ok) {
          if (result.reason === 'notFound') {
            return `Documento não encontrado: ${documentId}. Use list_documents para ver os disponíveis.`
          }
          // Nada foi gravado. Repetir a mesma reescrita repetiria o erro: o
          // caminho é reler e reaplicar a mudança sobre a versão nova.
          return `O documento mudou desde a versão em que você se baseou — provavelmente o usuário o editou no painel (ele está agora na revisão ${result.revision}). NADA foi gravado. Chame read_document, reaplique sua alteração sobre o texto que voltar e chame update_document de novo com o baseRevision que a leitura informar. Não repita a mesma reescrita: ela apagaria a edição dele.`
        }
        const ref = result.ref
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
        'Returns the Markdown source of a document and the revision it is at. Always read before editing: rewriting from memory silently drops whatever you had forgotten, and the user may have changed the document in the side panel since you last saw it. Pass the revision back as baseRevision in update_document.',
      inputSchema: z.object({
        documentId: z.string().describe('Document id (doc_....md)'),
      }),
      execute: async ({ documentId }) => {
        const found = await readDocumentSource(documentId)
        if (!found) return `Documento não encontrado: ${documentId}.`
        // A revisão volta no próprio envelope: é o que o update_document pede
        // de volta para provar que a reescrita partiu DESTA versão.
        const revision = found.entry.revision ?? 1
        return `<document id="${documentId}" title="${found.entry.name ?? ''}" revision="${revision}">\n${found.markdown}\n</document>\nAo reescrever este documento, passe baseRevision=${revision}.`
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
