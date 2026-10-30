import { app } from 'electron'
import path from 'node:path'
import type { PieceKind } from '../session/media-journal'

/**
 * Where a PIECE lives: its own module because a piece path is needed on both
 * sides — in the tools (`piece-common`) and in the project import
 * (`video/motion-project`), which has no reason to drag media, journal and the
 * other pieces along just to know the name of a folder.
 */

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,80}$/

/** Folder of all pieces of a type — the root that deletion can clean. */
export function piecesRoot(kind: PieceKind): string {
  return path.join(app.getPath('userData'), 'orbit-data', kind)
}

/** Folder of the pieces of a type in this conversation. */
export function piecesDir(kind: PieceKind, sessionId: string): string {
  if (!SAFE_SESSION.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return path.join(piecesRoot(kind), sessionId)
}

/** "Orbit intro!" → "orbit-intro". The name becomes a folder. Pure. */
export function pieceSlug(name: string, fallback: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || fallback
}
