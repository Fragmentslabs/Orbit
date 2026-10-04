import { setArchivedState } from '@shared/archive'
import { StorageKeys, type SessionInfo } from '@shared/chat'
import { getAppSettings, onAppSettingsChange } from './app-settings'
import { getRunningSessionIds } from './chat-engine'
import { broadcastSessionEvent } from './companion-server'
import { listKeys, readJson, writeJson } from './storage'

/**
 * Arquivamento automático de conversas inativas (Preferências → Geral).
 *
 * Arquivar é reversível: a conversa sai da lista principal e vai para o grupo
 * de arquivados, com a pasta preservada. Ficam de fora o que o usuário marcou
 * para ficar (fixadas), o que não é uma conversa dele (execuções de rotina e
 * sub-sessões de orquestração) e o que está respondendo agora.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const INTERVAL_MS = 6 * 60 * 60 * 1000

export function staleSessions(
  sessions: SessionInfo[],
  days: number,
  now: number,
  running: ReadonlySet<string>,
): SessionInfo[] {
  const cutoff = now - days * DAY_MS
  return sessions.filter(
    (s) =>
      !s.archived &&
      !s.pinned &&
      !s.routineId &&
      !s.parentId &&
      !running.has(s.id) &&
      s.updatedAt < cutoff,
  )
}

export async function archiveInactiveSessions(now = Date.now()): Promise<number> {
  const days = getAppSettings().autoArchiveDays
  if (!days) return 0
  const keys = await listKeys(StorageKeys.sessionPrefix)
  const sessions = (await Promise.all(keys.map((k) => readJson<SessionInfo>(k)))).filter(
    (s): s is SessionInfo => s != null,
  )
  const stale = staleSessions(sessions, days, now, new Set(getRunningSessionIds()))
  for (const session of stale) {
    // updatedAt fica como estava: arquivar não é atividade, e mexer nele
    // reordenaria a lista de arquivados.
    const next = setArchivedState(session, true, now)
    await writeJson(StorageKeys.session(session.id), next)
    broadcastSessionEvent({ type: 'session', sessionId: session.id, session: next })
  }
  if (stale.length > 0) console.log(`[auto-archive] ${stale.length} conversa(s) inativa(s) arquivada(s)`)
  return stale.length
}

export function setupAutoArchive(): void {
  const run = () => void archiveInactiveSessions().catch((err) => console.error('[auto-archive] falhou:', err))
  setInterval(run, INTERVAL_MS)
  // Ligar a opção (ou encurtar o prazo) vale na hora, não só na próxima rodada.
  onAppSettingsChange((next, prev) => {
    if (next.autoArchiveDays && next.autoArchiveDays !== prev.autoArchiveDays) run()
  })
  run()
}
