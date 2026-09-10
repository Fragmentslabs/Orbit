import type { TFunction } from 'i18next'
import type { ConnectionErrorReason, ConnectionState } from '@orbit/companion-client'

/** Chave de tradução de cada motivo de falha de conexão. */
const MESSAGE_KEY: Record<ConnectionErrorReason, string> = {
  invalid_pin: 'connectionErrors.invalid_pin',
  already_paired: 'connectionErrors.already_paired',
  rate_limited: 'connectionErrors.rate_limited',
  connect_failed: 'connectionErrors.connect_failed',
  socket_error: 'connectionErrors.socket_error',
  unknown: 'connectionErrors.unknown',
}

/**
 * Falha de conexão pronta para exibir (já no idioma do app), ou null quando não
 * há falha. A frase nunca vem do companion-client: o pacote transporta só o
 * código do motivo (`errorReason`), que aqui vira texto.
 */
export function connectionErrorMessage(state: ConnectionState, t: TFunction): string | null {
  if (state.errorReason) {
    // `?? unknown` cobre um motivo novo vindo de um desktop/app mais recente.
    const key = MESSAGE_KEY[state.errorReason] ?? MESSAGE_KEY.unknown
    return t(key, { attempts: state.reconnectAttempt })
  }
  // Sem código: resta o detalhe técnico cru (ex.: exceção do WebSocket).
  return state.error ?? null
}
