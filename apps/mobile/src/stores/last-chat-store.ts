import { Storage } from '~/lib/storage'

/**
 * Último chat aberto no aparelho. Ao reabrir o app (ou reconectar), a rota
 * inicial volta para ele em vez de cair num chat novo — o `activeSessionId`
 * do session-store é só memória e morria junto com o processo.
 */

const LAST_SESSION_KEY = 'orbit_last_session'

/** null (chat novo aberto) limpa a chave. */
export async function saveLastSessionId(sessionId: string | null): Promise<void> {
  try {
    if (sessionId) await Storage.setItem(LAST_SESSION_KEY, sessionId)
    else await Storage.removeItem(LAST_SESSION_KEY)
  } catch {
    // Persistência é oportunista.
  }
}

export async function loadLastSessionId(): Promise<string | null> {
  try {
    const raw = await Storage.getItem(LAST_SESSION_KEY)
    return raw || null
  } catch {
    return null
  }
}
