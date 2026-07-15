/**
 * Helpers para geração e parsing de QR codes de conexão.
 *
 * Formato do payload (JSON stringificado):
 * { "h": host, "p": port, "v": 1 }
 *
 * O PIN NÃO vai no QR code (digitado separadamente por segurança).
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
}

// ─── Functions ───────────────────────────────────────────────────────────────

/**
 * Gera o payload para exibir como QR code.
 * O PIN deve ser informado pelo usuário separadamente.
 */
export function generateConnectionPayload(host: string, port: number): string {
  const payload: QrPayload = { h: host, p: port, v: 1 }
  return JSON.stringify(payload)
}

/**
 * Faz parse de um payload escaneado de QR code.
 * Retorna a configuração (sem PIN) ou null se inválido.
 */
export function parseConnectionPayload(data: string): Omit<ConnectionConfig, 'pin'> | null {
  try {
    const parsed = JSON.parse(data) as QrPayload

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.h === 'string' &&
      typeof parsed.p === 'number' &&
      parsed.v === 1
    ) {
      return { host: parsed.h, port: parsed.p }
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
