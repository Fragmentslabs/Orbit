import type { TFunction } from 'i18next'
import type { ConnectionErrorReason, ConnectionState } from '@orbit/companion-client'

/** Translation key of each connection failure reason. */
const MESSAGE_KEY: Record<ConnectionErrorReason, string> = {
  invalid_pin: 'connectionErrors.invalid_pin',
  already_paired: 'connectionErrors.already_paired',
  rate_limited: 'connectionErrors.rate_limited',
  connect_failed: 'connectionErrors.connect_failed',
  socket_error: 'connectionErrors.socket_error',
  unknown: 'connectionErrors.unknown',
}

/**
 * Connection failure ready to display (already in the app language), or null when there
 * is no failure. The sentence never comes from the companion-client: the package carries only the
 * reason code (`errorReason`), which becomes text here.
 */
export function connectionErrorMessage(state: ConnectionState, t: TFunction): string | null {
  if (state.errorReason) {
    // `?? unknown` covers a new reason coming from a newer desktop/app.
    const key = MESSAGE_KEY[state.errorReason] ?? MESSAGE_KEY.unknown
    return t(key, { attempts: state.reconnectAttempt })
  }
  // No code: what is left is the raw technical detail (e.g. WebSocket exception).
  return state.error ?? null
}
