import fsp from 'node:fs/promises'
import { mediaKind } from '@shared/media'
import {
  documentFilePath,
  ensureDocumentRender,
  getMediaEntry,
  readDocumentSource,
  setDocumentSourceId,
} from './media'
import { addSessionDocument, addSessionText, listSessionDocuments } from './session-documents'

/**
 * Promover um documento que o agente produziu a FONTE da conversa.
 *
 * São dois espaços com significados diferentes — a galeria guarda o que o
 * agente produziu, as Fontes guardam o que a conversa lê — e o caminho entre
 * eles é um ato explícito do usuário, nunca automático. O motivo não é
 * arrumação: uma saída que escorre sozinha para as fontes faz o agente citar o
 * próprio relatório como se fosse evidência.
 *
 * O que entra é o conteúdo, não o arquivo: um documento com fonte em Markdown
 * vai como texto, que pagina e busca melhor do que o PDF renderizado dele. Só
 * os DERIVADOS (cópia de um .docx anexado, junção de PDFs) entram pelo
 * arquivo, porque neles o Markdown é um bilhete e o conteúdo real está no
 * binário.
 *
 * Vive num módulo próprio porque junta os dois lados: `media` não conhece as
 * fontes da conversa e `session-documents` não conhece a galeria — e é bom que
 * continue assim.
 */

/** Nome com que o documento aparece na aba Fontes. */
function sourceName(title: string, ext?: string): string {
  const base = title.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 60) || 'Documento'
  return ext ? `${base}.${ext}` : base
}

/**
 * O documento é fonte desta conversa AGORA?
 *
 * Não basta ter `sourceId`: o usuário pode ter removido a fonte na aba Fontes
 * depois de promovê-la, e aí o botão tem que voltar a oferecer a promoção em
 * vez de fingir que já está lá.
 */
export async function isDocumentSource(sessionId: string, documentId: string): Promise<boolean> {
  const entry = await getMediaEntry(documentId)
  if (!entry?.sourceId) return false
  const current = await listSessionDocuments(sessionId)
  return current.some((doc) => doc.id === entry.sourceId)
}

export type UseAsSourceResult =
  | { ok: true; sourceId: string; already: boolean }
  | { ok: false; error: string }

export async function useDocumentAsSource(
  sessionId: string,
  documentId: string,
): Promise<UseAsSourceResult> {
  const entry = await getMediaEntry(documentId)
  if (!entry || mediaKind(entry) !== 'document') {
    return { ok: false, error: `Documento não encontrado: ${documentId}.` }
  }

  // Já promovido antes. O id é conferido contra a lista porque o usuário pode
  // ter removido a fonte depois — e aí promover de novo é justamente o que ele
  // quer, não uma duplicata.
  if (entry.sourceId) {
    const current = await listSessionDocuments(sessionId)
    if (current.some((doc) => doc.id === entry.sourceId)) {
      return { ok: true, sourceId: entry.sourceId, already: true }
    }
  }

  const title = entry.name ?? documentId
  const added = entry.derived
    ? await fromRenderedFile(sessionId, documentId, title)
    : await fromMarkdown(sessionId, documentId, title)
  if (!added.ok) return added

  await setDocumentSourceId(documentId, added.sourceId)
  return added
}

/** Documento escrito pelo agente: entra como texto, que é o próprio fonte. */
async function fromMarkdown(
  sessionId: string,
  documentId: string,
  title: string,
): Promise<UseAsSourceResult> {
  const found = await readDocumentSource(documentId)
  if (!found) return { ok: false, error: 'Não foi possível ler o documento.' }
  const result = await addSessionText(sessionId, sourceName(title), found.markdown, false)
  return result.ok ? { ok: true, sourceId: result.doc.id, already: false } : result
}

/**
 * Documento derivado: entra pelo ARQUIVO, que é onde o conteúdo está. O PDF
 * tem precedência sobre o .docx por extrair melhor, e é gerado se ainda não
 * existir — o derivado sempre tem um dos dois.
 */
async function fromRenderedFile(
  sessionId: string,
  documentId: string,
  title: string,
): Promise<UseAsSourceResult> {
  for (const ext of ['pdf', 'docx'] as const) {
    const file = (await documentFilePath(documentId, ext)) ?? (await ensureDocumentRender(documentId, ext))
    if (!file) continue
    const bytes = await fsp.readFile(file).catch(() => null)
    if (!bytes) continue
    const result = await addSessionDocument(sessionId, sourceName(title, ext), bytes, false)
    return result.ok ? { ok: true, sourceId: result.doc.id, already: false } : result
  }
  return { ok: false, error: 'Este documento não tem arquivo para virar fonte.' }
}
