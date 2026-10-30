import type { ChatModeKey } from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'

/**
 * Mode toggle made on the phone → desktop, which is the source of truth for the
 * per-chat modes (they live in the renderer's localStorage). The desktop applies it to its
 * store and sends the whole map back to all companions.
 *
 * Lives outside the stores so as not to create an import cycle: the mode stores
 * import from here, and session-modes-sync imports the stores.
 */
export function pushModeSelect(
  mode: ChatModeKey,
  sessionId: string | null | undefined,
  value: boolean,
): void {
  // A draft does not travel: "draft" on the phone is a new chat different from the "draft"
  // of the desktop. When the session is born, adopt() pushes the modes with the real id.
  if (!sessionId) return

  const { wsClient } = useConnectionStore.getState()
  // Disconnected, the send stays in the wsClient queue and goes out on reconnection; if it fails
  // for good, that is fine: the modes travel in every message sent (options), so
  // the execution comes out right — only the desktop is left unaware of the toggle.
  void wsClient
    .send({ type: 'modes:select', mode, value, sessionId: sessionId ?? null })
    .catch(() => {})
}
