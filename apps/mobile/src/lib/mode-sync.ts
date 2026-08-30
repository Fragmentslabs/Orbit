import type { ChatModeKey } from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'

/**
 * Toggle de modo feito no celular → desktop, que é a fonte da verdade dos
 * modos por chat (eles vivem no localStorage do renderer). O desktop aplica no
 * store dele e devolve o mapa inteiro a todos os companions.
 *
 * Vive fora dos stores para não criar ciclo de import: os stores de modo
 * importam daqui, e o session-modes-sync importa os stores.
 */
export function pushModeSelect(
  mode: ChatModeKey,
  sessionId: string | null | undefined,
  value: boolean,
): void {
  // Rascunho não viaja: "draft" no celular é um chat novo diferente do "draft"
  // do desktop. Quando a sessão nasce, o adopt() empurra os modos com o id real.
  if (!sessionId) return

  const { wsClient } = useConnectionStore.getState()
  // Desconectado o send fica na fila do wsClient e sai na reconexão; se falhar
  // de vez, tudo bem: os modos viajam em cada mensagem enviada (options), então
  // a execução sai correta — só o desktop fica sem saber do toggle.
  void wsClient
    .send({ type: 'modes:select', mode, value, sessionId: sessionId ?? null })
    .catch(() => {})
}
