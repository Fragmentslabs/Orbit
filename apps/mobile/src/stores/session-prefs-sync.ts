import type { SessionPrefsSnapshot } from '@orbit/shared'
import { useConnectionStore } from './connection-store'
import { useSessionReasoning } from './session-reasoning'
import { usePermissionPrefs } from './permission-prefs'

/**
 * Thinking e autonomia POR CHAT vindos do desktop. O desktop é a fonte da
 * verdade: empurra o snapshot inteiro no connect (GET /api/session-prefs) e a
 * cada mudança (evento WS 'session:prefs-change').
 *
 * `authoritative` separa os dois casos, como nos modos por chat: no connect a
 * escolha feita no celular vence (só entra o que falta); no evento ao vivo o
 * desktop acabou de mudar, então ele substitui.
 */

/** O rascunho é por aparelho — nunca viaja em nenhuma direção. */
const DRAFT_KEY = 'draft'

async function ensureHydrated(): Promise<void> {
  const pending: Promise<void>[] = []
  if (!useSessionReasoning.getState().hydrated) pending.push(useSessionReasoning.getState().hydrate())
  if (!usePermissionPrefs.getState().hydrated) pending.push(usePermissionPrefs.getState().hydrate())
  if (pending.length > 0) await Promise.all(pending)
}

function semRascunho<T>(map: Record<string, T> | undefined): Record<string, T> {
  if (!map || typeof map !== 'object') return {}
  return Object.fromEntries(Object.entries(map).filter(([key]) => key !== DRAFT_KEY))
}

export function applyRemoteSessionPrefs(prefs: SessionPrefsSnapshot, authoritative: boolean): void {
  if (!prefs || typeof prefs !== 'object') return

  const reasoning = semRascunho(prefs.reasoning)
  if (Object.keys(reasoning).length > 0) {
    useSessionReasoning.getState().applySync(reasoning, authoritative)
  } else if (authoritative) {
    // Mapa vazio ao vivo = ninguém escolheu nada lá; aqui também não sobra
    // override (todo chat volta a seguir o nível do modelo).
    useSessionReasoning.getState().applySync({}, true)
  }

  const permission = semRascunho(prefs.permission)
  const permissionState = usePermissionPrefs.getState()
  for (const [sessionId, mode] of Object.entries(permission)) {
    // No connect, o que o celular já escolheu vence; ao vivo o desktop manda.
    if (!authoritative && permissionState.modes[sessionId] !== undefined) continue
    if (permissionState.modes[sessionId] === mode) continue
    permissionState.applyRemoteMode(sessionId, mode)
  }
}

/** Snapshot do desktop — chamado no connect. */
export async function fetchSessionPrefs(): Promise<void> {
  const { http } = useConnectionStore.getState()
  if (!http) return
  await ensureHydrated()
  try {
    const res = await http.getSessionPrefs()
    if (res.ok && res.data) applyRemoteSessionPrefs(res.data, false)
  } catch {
    // Offline — fica com o que já está no aparelho.
  }
}
