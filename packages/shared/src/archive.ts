import type { SessionInfo } from './chat'

/**
 * Arquivamento e exclusão de conversas arquivadas.
 *
 * Toda mudança de `archived` passa por `setArchivedState`, para `archivedAt`
 * acompanhar: é dele que a exclusão automática conta o prazo, e não de
 * `updatedAt` — arquivar à mão uma conversa parada há meses não pode fazê-la
 * sumir no mesmo instante.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** A sessão com o arquivamento ligado/desligado; `archivedAt` acompanha. */
export function setArchivedState<T extends SessionInfo>(session: T, archived: boolean, now = Date.now()): T {
  if (session.archived === archived) return session
  return { ...session, archived, archivedAt: archived ? now : null }
}

export interface ArchivedCleanupPlan {
  /** Arquivadas há mais do que o prazo: podem ser excluídas. */
  expired: SessionInfo[]
  /**
   * Arquivadas antes de `archivedAt` existir: o prazo começa agora (ganham a
   * data atual), em vez de saírem de uma vez assim que a opção é ligada.
   */
  undated: SessionInfo[]
}

/**
 * O que a exclusão automática faz com as conversas arquivadas. Ficam de fora as
 * fixadas, as que estão respondendo e os workers de orquestração (saem junto
 * com o orquestrador, na cascata de exclusão).
 */
export function planArchivedCleanup(
  sessions: SessionInfo[],
  days: number,
  now: number,
  running: ReadonlySet<string>,
): ArchivedCleanupPlan {
  const cutoff = now - days * DAY_MS
  const expired: SessionInfo[] = []
  const undated: SessionInfo[] = []
  for (const s of sessions) {
    if (!s.archived || s.pinned || s.parentId || running.has(s.id)) continue
    if (typeof s.archivedAt !== 'number') undated.push(s)
    else if (s.archivedAt <= cutoff) expired.push(s)
  }
  return { expired, undated }
}
