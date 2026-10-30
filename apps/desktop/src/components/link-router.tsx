import { useEffect } from "react"
import { useWorkspace } from "@/lib/workspace-context"
import { appSettingsApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Links clicked in the app with "Open links in the built-in browser" on: the
 * main process sends the URL over here because only the renderer knows which conversation is
 * open — the link becomes a new browser tab in ITS panel. With no conversation
 * open (another screen, new chat), there is no panel to open it in, and the link goes to
 * the system browser.
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
