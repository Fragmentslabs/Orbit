import { useConnectionStore } from '~/stores/connection-store'

/**
 * Tool selection made on the phone → desktop, which is the source of truth for the
 * per-chat tools (they live in the renderer's localStorage, like the mode toggles).
 * The desktop applies it in its store and sends the whole map back to every companion.
 *
 * Lives outside the store so as not to create an import cycle: the store imports from
 * here, and session-tools-sync imports the store.
 */
export function pushToolsSelect(
  sessionId: string | null | undefined,
  servers: string[] | null,
): void {
  // A draft does not travel: "draft" on the phone is a new chat different from the
  // "draft" of the desktop. When the session is born, adopt() pushes it with the real id.
  if (!sessionId) return

  const { wsClient } = useConnectionStore.getState()
  // Disconnected, the send stays in the wsClient queue and goes out on reconnection; if it
  // fails for good, that is fine: the selection travels in every message (options), so
  // the execution comes out right — only the desktop is left unaware of the change.
  void wsClient.send({ type: 'tools:select', sessionId, servers }).catch(() => {})
}
