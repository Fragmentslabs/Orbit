import { app } from 'electron'
import path from 'node:path'
import type { PieceKind } from '../session/media-journal'

/**
 * Onde uma PEÇA mora: módulo próprio porque caminho de peça é preciso nos dois
 * lados — nas tools (`piece-common`) e na importação de projeto
 * (`video/motion-project`), que não tem por que arrastar media, diário e as
 * outras peças só para saber o nome de uma pasta.
 */

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,80}$/

/** Pasta de todas as peças de um tipo — a raiz que a exclusão pode limpar. */
export function piecesRoot(kind: PieceKind): string {
  return path.join(app.getPath('userData'), 'orbit-data', kind)
}

/** Pasta das peças de um tipo nesta conversa. */
export function piecesDir(kind: PieceKind, sessionId: string): string {
  if (!SAFE_SESSION.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return path.join(piecesRoot(kind), sessionId)
}

/** "Intro do Orbit!" → "intro-do-orbit". O nome vira pasta. Puro. */
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
