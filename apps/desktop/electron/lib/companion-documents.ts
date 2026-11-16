import type { IncomingMessage, ServerResponse } from 'http'

import { viewHtml, viewText } from './document-view'

/**
 * Document reading for the phone's viewer.
 *
 * The desktop panel gets a document's text (and the .docx converted to HTML) through IPC
 * (`docs:text`, `docs:html`); these are the same two facades over HTTP. They cover what the
 * signed `/api/file` scopes cannot: a conversation source (`docN`/`srcN`) is not a file in
 * any asset scope, and a citation needs its numbered lines.
 *
 * `docId` is either a conversation source or a gallery document id; `viewText` tells them apart.
 */

type Json = (res: ServerResponse, status: number, data: unknown) => void

function parse(req: IncomingMessage, docId: string): { sessionId: string; docId: string } | null {
  let id: string
  try {
    id = decodeURIComponent(docId)
  } catch {
    return null
  }
  if (!id || id.length > 200) return null
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  return { sessionId: url.searchParams.get('sessionId') ?? '', docId: id }
}

export async function handleGetDocumentText(
  req: IncomingMessage,
  res: ServerResponse,
  docId: string,
  json: Json,
): Promise<void> {
  const args = parse(req, docId)
  const view = args ? await viewText(args.sessionId, args.docId) : null
  if (!view) return json(res, 404, { error: 'document not found' })
  json(res, 200, view)
}

export async function handleGetDocumentHtml(
  req: IncomingMessage,
  res: ServerResponse,
  docId: string,
  json: Json,
): Promise<void> {
  const args = parse(req, docId)
  const view = args ? await viewHtml(args.sessionId, args.docId) : null
  if (!view) return json(res, 404, { error: 'document not found' })
  json(res, 200, view)
}
