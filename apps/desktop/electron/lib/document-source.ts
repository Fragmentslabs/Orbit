import fsp from 'node:fs/promises'
import { mediaKind } from '@shared/media'
import { documentFilePath, ensureDocumentRender, getMediaEntry, listMedia, readDocumentSource, setDocumentSourceId } from './media'
import { addSessionDocument, addSessionText, listSessionDocuments } from './session-documents'

/**
 * Promoting a document the agent produced to the conversation's SOURCE.
 *
 * They are two spaces with different meanings — the gallery keeps what the
 * agent produced, the Sources keep what the conversation reads — and the path between
 * them is an explicit act of the user, never automatic. The reason is not
 * tidiness: an output that slides into the sources on its own makes the agent cite its
 * own report as if it were evidence.
 *
 * What enters is the content, not the file: a document with a Markdown source
 * goes as text, which paginates and searches better than the PDF rendered from it. Only
 * the DERIVED ones (a copy of an attached .docx, a merge of PDFs) enter by
 * file, because in them the Markdown is a note and the real content is in the
 * binary.
 *
 * It lives in a module of its own because it joins both sides: `media` does not know the
 * conversation's sources and `session-documents` does not know the gallery — and it is good that
 * it stays that way.
 */

/** Name with which the document appears in the Sources tab. */
function sourceName(title: string, ext?: string): string {
  const base = title.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 60) || 'Documento'
  return ext ? `${base}.${ext}` : base
}

/**
 * Is the document a source of this conversation NOW?
 *
 * Having `sourceId` is not enough: the user may have removed the source in the Sources tab
 * after promoting it, and then the button has to offer the promotion again
 * instead of pretending it is already there.
 */
export async function isDocumentSource(sessionId: string, documentId: string): Promise<boolean> {
  const entry = await getMediaEntry(documentId)
  if (!entry?.sourceId) return false
  const current = await listSessionDocuments(sessionId)
  return current.some((doc) => doc.id === entry.sourceId)
}

/**
 * The document that ORIGINATED this source, when it came from a promotion.
 *
 * Promoting copies the content into a source with an id of its own, and from then on the
 * two exist in parallel — but whoever clicks the source is clicking the same
 * document, and expects the canvas where it is read and edited, not the file
 * viewer. The way back is looked up in the record (the document keeps `sourceId`)
 * because that is where the link already lives: storing it also on the source's side would create
 * a second place for it to go stale.
 */
export async function documentForSource(
  sourceId: string,
): Promise<{ documentId: string; title: string } | null> {
  const entries = await listMedia({ kind: 'document' })
  const owner = entries.find((entry) => entry.sourceId === sourceId)
  return owner ? { documentId: owner.id, title: owner.name ?? owner.id } : null
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
    return { ok: false, error: `Document not found: ${documentId}.` }
  }

  // Already promoted before. The id is checked against the list because the user may
  // have removed the source later — and then promoting again is precisely what they
  // want, not a duplicate.
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

/** Document written by the agent: it comes in as text, which is the source itself. */
async function fromMarkdown(
  sessionId: string,
  documentId: string,
  title: string,
): Promise<UseAsSourceResult> {
  const found = await readDocumentSource(documentId)
  if (!found) return { ok: false, error: 'Could not read the document.' }
  const result = await addSessionText(sessionId, sourceName(title), found.markdown, false)
  return result.ok ? { ok: true, sourceId: result.doc.id, already: false } : result
}

/**
 * Derived document: it comes in by the FILE, which is where the content is. The PDF
 * takes precedence over the .docx for extracting better, and is generated if it does not
 * exist yet — the derived one always has one of the two.
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
  return { ok: false, error: 'This document has no file to become a source.' }
}
