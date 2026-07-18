/**
 * Helpers para geração e parsing de QR codes de conexão.
 *
 * Formato do payload (JSON stringificado):
 * { "h": host, "p": port, "v": 1, "pin"?: pin }
 *
 * O PIN é opcional no payload: o QR code já é exibido lado a lado com o PIN
 * em texto claro no desktop, então incluí-lo permite conectar com um único
 * scan sem abrir mão de segurança adicional (quem vê o QR já vê o PIN).
 */

import type { ConnectionConfig } from './types'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QrPayload {
  /** Host (IP ou hostname). */
  h: string
  /** Porta WebSocket. */
  p: number
  /** Versão do protocolo. */
  v: number
  /** PIN de pareamento (opcional — mesmo exibido em texto ao lado do QR). */
  pin?: string
}

// ─── Functions ───────────────────────────────────────────────────────────────

/**
 * Gera o payload para exibir como QR code.
 */
export function generateConnectionPayload(host: string, port: number, pin?: string): string {
  const payload: QrPayload = { h: host, p: port, v: 1, ...(pin ? { pin } : {}) }
  return JSON.stringify(payload)
}

/**
 * Faz parse de um payload escaneado de QR code.
 * Retorna a configuração (com PIN se presente no payload) ou null se inválido.
 */
export function parseConnectionPayload(data: string): Omit<ConnectionConfig, 'pin'> & { pin?: string } | null {
  try {
    const parsed = JSON.parse(data) as QrPayload

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.h === 'string' &&
      typeof parsed.p === 'number' &&
      parsed.v === 1
    ) {
      return {
        host: parsed.h,
        port: parsed.p,
        ...(typeof parsed.pin === 'string' ? { pin: parsed.pin } : {}),
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Valida se um PIN tem formato aceitável (6 dígitos numéricos).
 */
export function isValidPin(pin: string): boolean {
  return /^\d{6}$/.test(pin)
}
