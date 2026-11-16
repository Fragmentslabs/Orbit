/**
 * HTTP handlers of `/api/files/*` (see companion-files.ts for the logic and
 * @shared/companion-files for the wire types).
 *
 * All four are POST with a JSON body: the session id and the relative path travel in the
 * body, not in the URL, so they never end up in a log line or a percent-encoding bug.
 * Errors are `{ ok: false, error }` with the status that fits; a refused WRITE is still a
 * 200 with `{ ok: false, reason }` because the phone needs the body (the `stale` content).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { StorageKeys, type SessionInfo } from '@shared/chat'
import { readJson } from './storage'
import { createAssetToken } from './companion-token'
import { recordManualSave } from './manual-saves'
import {
  FilesError,
  encodeWorkspaceId,
  listDirectory,
  pickRoot,
  readFileEntry,
  searchFileNames,
  writeFileEntry,
} from './companion-files'

const MAX_BODY_BYTES = 4 * 1024 * 1024

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(data))
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new FilesError('Body too large', 400))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {})
      } catch {
        reject(new FilesError('Invalid JSON', 400))
      }
    })
    req.on('error', reject)
  })
}

/** The session's folders: main first, then the extra ones. */
async function sessionRoots(sessionId: unknown): Promise<string[]> {
  if (typeof sessionId !== 'string' || !sessionId) throw new FilesError('sessionId required', 400)
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  if (!session) throw new FilesError('Session not found', 404)
  return [session.directory, ...(session.extraDirectories ?? [])].filter(
    (d): d is string => typeof d === 'string' && d !== '',
  )
}

async function scoped(req: IncomingMessage) {
  const body = await readBody(req)
  const roots = await sessionRoots(body.sessionId)
  return { body, roots, root: pickRoot(roots, body.root) }
}

function wrap(
  run: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      send(res, 200, await run(req, res))
    } catch (err) {
      if (err instanceof FilesError) send(res, err.status, { ok: false, error: err.message })
      else send(res, 500, { ok: false, error: (err as Error).message })
    }
  }
}

export const handleFilesList = wrap(async (req) => {
  const { body, roots, root } = await scoped(req)
  return listDirectory(root, roots, typeof body.path === 'string' ? body.path : '')
})

export const handleFilesRead = wrap(async (req) => {
  const { body, root } = await scoped(req)
  const host = req.headers.host ?? 'localhost'
  return readFileEntry(root, String(body.path ?? ''), (rel) => {
    const id = encodeWorkspaceId(root, rel)
    const name = encodeURIComponent(path.basename(rel))
    return `http://${host}/api/file/workspace/${id}/${createAssetToken('workspace', id)}/${name}`
  })
})

export const handleFilesWrite = wrap(async (req) => {
  const { body, root } = await scoped(req)
  if (typeof body.content !== 'string') throw new FilesError('content required', 400)
  const expected = typeof body.expectedMtimeMs === 'number' ? body.expectedMtimeMs : undefined
  return writeFileEntry(root, String(body.path ?? ''), body.content, expected, recordManualSave)
})

export const handleFilesSearch = wrap(async (req) => {
  const { body, root } = await scoped(req)
  return searchFileNames(root, typeof body.query === 'string' ? body.query : '')
})
