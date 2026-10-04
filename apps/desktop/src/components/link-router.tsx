import { useEffect } from "react"
import { useWorkspace } from "@/lib/workspace-context"
import { appSettingsApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Links clicados no app com "Abrir links no navegador integrado" ligado: o
 * main manda a URL para cá porque só o renderer sabe qual conversa está
 * aberta — o link vira uma aba nova do navegador no painel DELA. Sem conversa
 * aberta (outra tela, chat novo), não há painel onde abrir, e o link vai para
 * o navegador do sistema.
 */
export function LinkRouter() {
  const { mode, view } = useWorkspace()

  useEffect(
    () =>
      appSettingsApi.onLinkOpen((url) => {
        const sessionId = useSessionStore.getState().activeIds[mode]
        if (view === "chat" && sessionId) usePanelStore.getState().openTerminalLink(sessionId, url)
        else appSettingsApi.openExternal(url)
      }),
    [mode, view],
  )

  return null
}
