import fsp from 'node:fs/promises'
import { dialog } from 'electron'
import { extractDocument } from './documents'
import { documentFilePath, getMediaEntry } from './media'
import { printFile, rasterizePdf, type PdfOutlineItem, type PdfTextItem } from './pdf-raster'
import {
  exportSessionDocument,
  printSessionDocument,
  readSessionText,
  renderSessionPages,
  type SessionDocumentView,
} from './session-documents'

/**
 * O que o painel lateral precisa de um documento, venha ele de onde vier.
 *
 * São duas origens com armazenamento diferente: as FONTES da conversa (anexos
 * e fontes da pasta, em session-docs/) e os DOCUMENTOS que o agente produziu
 * (na galeria de mídia). O painel é um só — o usuário abre "um PDF" e espera
 * sumário, localizar, zoom, imprimir e baixar nos dois casos.
 *
 * O id diz a origem: `doc1`/`src2` são fontes da conversa; qualquer outro é um
 * registro da galeria. Por isso a fachada não precisa de um parâmetro de tipo
 * que quem chama teria que acertar.
 *
 * As fontes têm caminho próprio (e não caem no genérico) porque nem todas são
 * arquivo: trecho colado e página baixada nascem como texto e não têm bytes
 * para rasterizar nem para baixar.
 */

/** Id de fonte da conversa. O resto é id da galeria (doc_xxxx.md). */
const SESSION_DOC = /^(doc|src)[0-9]+$/

function isSessionDoc(id: string): boolean {
  return SESSION_DOC.test(id)
}

/** Arquivo de um documento da galeria: o PDF quando houver, senão o .docx. */
async function mediaFile(id: string): Promise<{ path: string; ext: 'pdf' | 'docx' } | null> {
  for (const ext of ['pdf', 'docx'] as const) {
    const file = await documentFilePath(id, ext)
    if (file) return { path: file, ext }
  }
  return null
}

/** Texto paginado do documento, para o modo Texto e para a contagem da busca. */
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
    // Extrai do ARQUIVO RENDERIZADO, e não do Markdown de origem: é o que faz
    // a página 3 do texto ser a página 3 que a imagem mostra. O cache da
    // extração é por hash do conteúdo, então relê de graça.
    const extracted = await extractDocument(bytes, file.ext === 'pdf' ? 'pdf' : 'docx')
    return {
      filename: entry?.name ?? id,
      kind: file.ext === 'pdf' ? 'pdf' : 'docx',
      totalPages: extracted.totalPages,
      pages: extracted.pages.map((p) => ({
        num: p.num,
        label: p.label,
        lines: p.text.split('\n'),
      })),
      hasOriginal: file.ext === 'pdf',
    }
  } catch {
    return null
  }
}

/** Páginas desenhadas, com o trecho marcado. Só existe para PDF. */
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

export async function viewPrint(
  sessionId: string,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  if (isSessionDoc(id)) return printSessionDocument(sessionId, id)
  const file = await mediaFile(id)
  if (!file) return { ok: false, error: 'Documento sem arquivo para imprimir.' }
  return printFile(file.path)
}

export async function viewExport(
  sessionId: string,
  id: string,
): Promise<{ ok: true; path: string } | { ok: false; canceled?: true; error?: string }> {
  if (isSessionDoc(id)) return exportSessionDocument(sessionId, id)

  const file = await mediaFile(id)
  if (!file) return { ok: false, error: 'Documento não encontrado.' }
  const entry = await getMediaEntry(id)
  const base = (entry?.name || 'documento').replace(/[\\/:*?"<>|]/g, '-').slice(0, 60)
  const result = await dialog.showSaveDialog({
    defaultPath: `${base}.${file.ext}`,
    filters: [{ name: file.ext.toUpperCase(), extensions: [file.ext] }],
  })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  try {
    await fsp.copyFile(file.path, result.filePath)
    return { ok: true, path: result.filePath }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
