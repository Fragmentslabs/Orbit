import {
  addSessionDocument,
  addSessionText,
  addSessionUrl,
  listSessionSources,
  removeSessionDocument,
  setSessionDocumentShared,
  type SessionDocument,
} from './session-documents'
import type { CompanionSource, CompanionSourcesList } from '@shared/companion'

/**
 * Sources tab for the phone: the same operations as the desktop IPC (`docs:*`), as plain
 * functions that return `{ status, body }` so the HTTP layer stays a thin adapter and the
 * rules are testable without a server.
 *
 * Nothing here has rules of its own — scoping (`docN` vs `srcN`), kind detection and the
 * change notice all live in session-documents.ts. What this file adds is validation of
 * what arrives from the network.
 */

export interface SourcesResult {
  status: number
  body: unknown
}

/** Same ceiling as the desktop tab (sources-tab.tsx MAX_FILE_BYTES). */
export const MAX_SOURCE_BYTES = 100 * 1024 * 1024

/** `draft` is the scope of a chat that is not a session yet; otherwise a session id. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

const fail = (status: number, error: string): SourcesResult => ({ status, body: { error } })

export function toCompanionSource(doc: SessionDocument): CompanionSource {
  return {
    id: doc.id,
    filename: doc.filename,
    kind: doc.kind,
    totalPages: doc.totalPages,
    truncated: doc.truncated,
    ...(doc.sizeBytes !== undefined ? { sizeBytes: doc.sizeBytes } : {}),
    createdAt: doc.createdAt,
    shared: doc.shared === true,
    ...(doc.sourceUrl ? { sourceUrl: doc.sourceUrl } : {}),
  }
}

export function validSessionId(id: string): boolean {
  return SESSION_ID.test(id)
}

export async function listSources(sessionId: string): Promise<SourcesResult> {
  if (!validSessionId(sessionId)) return fail(400, 'invalid session')
  const list = await listSessionSources(sessionId)
  const body: CompanionSourcesList = {
    shared: list.shared.map(toCompanionSource),
    own: list.own.map(toCompanionSource),
    folderId: list.folderId,
    usage: list.usage,
  }
  return { status: 200, body }
}

export async function addSourceFile(sessionId: string, input: Record<string, unknown>): Promise<SourcesResult> {
  if (!validSessionId(sessionId)) return fail(400, 'invalid session')
  const filename = typeof input.filename === 'string' ? input.filename.trim() : ''
  const data = typeof input.data === 'string' ? input.data : ''
  if (!filename || !data) return fail(400, 'filename and data are required')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) return fail(400, 'empty file')
  if (bytes.length > MAX_SOURCE_BYTES) return fail(413, 'file too large')
  const result = await addSessionDocument(sessionId, filename, bytes, input.shared === true)
  return result.ok ? { status: 200, body: { id: result.doc.id } } : fail(422, result.error)
}

export async function addSourceText(sessionId: string, input: Record<string, unknown>): Promise<SourcesResult> {
  if (!validSessionId(sessionId)) return fail(400, 'invalid session')
  const title = typeof input.title === 'string' ? input.title : ''
  const text = typeof input.text === 'string' ? input.text : ''
  const result = await addSessionText(sessionId, title, text, input.shared === true)
  return result.ok ? { status: 200, body: { id: result.doc.id } } : fail(422, result.error)
}

export async function addSourceUrl(sessionId: string, input: Record<string, unknown>): Promise<SourcesResult> {
  if (!validSessionId(sessionId)) return fail(400, 'invalid session')
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (!/^https?:\/\//i.test(url)) return fail(400, 'a http(s) url is required')
  const result = await addSessionUrl(sessionId, url, input.shared === true)
  return result.ok ? { status: 200, body: { id: result.doc.id } } : fail(422, result.error)
}

export async function shareSource(
  sessionId: string,
  docId: string,
  input: Record<string, unknown>,
): Promise<SourcesResult> {
  if (!validSessionId(sessionId)) return fail(400, 'invalid session')
  if (typeof input.shared !== 'boolean') return fail(400, 'shared must be a boolean')
  const result = await setSessionDocumentShared(sessionId, docId, input.shared)
  return result.ok ? { status: 200, body: { id: result.id } } : fail(422, result.error)
}

export async function removeSource(sessionId: string, docId: string): Promise<SourcesResult> {
  if (!validSessionId(sessionId)) return fail(400, 'invalid session')
  const removed = await removeSessionDocument(sessionId, docId)
  return removed ? { status: 200, body: { removed: true } } : fail(404, 'source not found')
}
