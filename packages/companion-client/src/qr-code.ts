/**
 * Helpers for generating and parsing connection QR codes.
 *
 * Payload format (stringified JSON):
 * { "h": host, "p": port, "v": 1, "pin"?: pin }
 *
 * The PIN is optional in the payload: the QR code is already shown side by side with the PIN
 * in clear text on the desktop, so including it allows connecting with a single
 * scan without giving up additional security (whoever sees the QR already sees the PIN).
 */

import type { ConnectionConfig } from './types'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QrPayload {
  /** Host (IP or hostname). */
  h: string
  /** WebSocket port. */
  p: number
  /** Protocol version. */
  v: number
  /** Pairing PIN (optional — the same shown as text next to the QR). */
  pin?: string
}

// ─── Functions ───────────────────────────────────────────────────────────────

/**
 * Generates the payload to display as a QR code.
 */
export function generateConnectionPayload(host: string, port: number, pin?: string): string {
  const payload: QrPayload = { h: host, p: port, v: 1, ...(pin ? { pin } : {}) }
  return JSON.stringify(payload)
}

/**
 * Parses a payload scanned from a QR code.
 * Returns the configuration (with the PIN if present in the payload) or null if invalid.
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
 * Validates whether a PIN has an acceptable format (6 numeric digits).
 */
export function isValidPin(pin: string): boolean {
  return /^\d{6}$/.test(pin)
}
