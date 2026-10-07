import type { ReasoningPrefsMap } from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'
import { useReasoningPrefsStore } from '~/stores/reasoning-prefs'

/**
 * Thinking por modelo vindo do desktop (toggle + variante). O desktop é a
 * fonte da verdade: empurra o mapa inteiro no connect (GET
 * /api/reasoning-prefs) e a cada mudança (evento WS 'reasoning:change').
 *
 * `authoritative` separa os dois casos, como no session-modes-sync: no
 * snapshot do connect a escolha feita no celular vence (só entram chaves que
 * o mobile não tem); no evento ao vivo o desktop acabou de mudar, então ele
 * sobrescreve.
 */
export async function applyReasoningPrefs(
  remote: ReasoningPrefsMap,
  authoritative: boolean,
): Promise<void> {
  // O evento ao vivo pode chegar antes da hidratação local (que lê o storage
  // do aparelho): aplicar direto apagaria um toggle feito offline. Hidrata
  // primeiro — é idempotente e o connect também passa por aqui.
  if (!useReasoningPrefsStore.getState().hydrated) {
    await useReasoningPrefsStore.getState().hydrate()
  }
  useReasoningPrefsStore.getState().applySync(remote, !authoritative)
}

/** Snapshot do thinking por modelo do desktop — chamado no connect. */
export async function fetchReasoningPrefs(): Promise<void> {
  const { http } = useConnectionStore.getState()
  if (!http) return
  if (!useReasoningPrefsStore.getState().hydrated) {
    await useReasoningPrefsStore.getState().hydrate()
  }
  try {
    const res = await http.getReasoningPrefs()
    if (res.ok && res.data) {
      const prefs = (res.data as { prefs?: ReasoningPrefsMap }).prefs
      if (prefs) await applyReasoningPrefs(prefs, false)
    }
  } catch {
    // Offline — fica com o que já está no aparelho.
  }
}
