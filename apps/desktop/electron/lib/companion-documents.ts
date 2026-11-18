import type { IncomingMessage, ServerResponse } from 'http'

import { viewHtml, viewRender, viewText } from './document-view'

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

/** Pages per call: each one opens a hidden window and each PNG travels as base64 over the LAN. */
const PAGES_MAX_COUNT = 4

/**
 * PDF pages as images with their positioned text (the desktop's `docs:render`): what the phone's
 * Original mode draws, with a transparent text layer over the picture for selection and the citation mark.
 * `?from=1&count=3&scale=1.4&text=1&outline=1`
 */
export async function handleGetDocumentPages(
  req: IncomingMessage,
  res: ServerResponse,
  docId: string,
  json: Json,
): Promise<void> {
  const args = parse(req, docId)
  if (!args) return json(res, 404, { error: 'document not found' })
  const query = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams
  const from = Math.max(1, Math.floor(Number(query.get('from'))) || 1)
  const count = Math.min(PAGES_MAX_COUNT, Math.max(1, Math.floor(Number(query.get('count'))) || 1))
  const scale = Math.min(2, Math.max(0.8, Number(query.get('scale')) || 1.4))
  const rendered = await viewRender(args.sessionId, args.docId, from, count, {
    scale,
    includeText: query.get('text') !== '0',
    includeOutline: query.get('outline') === '1',
  })
  if (!rendered) return json(res, 404, { error: 'document not found' })
  json(res, 200, rendered)
}
