import crypto from 'node:crypto'
import { WEBHOOK_MAX_PAYLOAD_CHARS } from '@shared/routines'

/**
 * Pure rules of the webhook receiver: how an address maps to a token, how a signature is
 * checked, how many calls are let through, and what the agent gets to read. No socket, no disk,
 * no clock of its own — the receiver feeds them, so each rule is tested alone.
 */

/** Unguessable part of the address: 32 random bytes, base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const WEBHOOK_PATH_PREFIX = '/hooks/'

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** The token a routine's address carries, derived from the app's key so it is never stored raw. */
export function deriveToken(key: Buffer, routineId: string, epoch: number): string {
  return crypto.createHmac('sha256', key).update(`${routineId}:${epoch}`).digest('base64url')
}

/** The token in "/hooks/<token>" (a query string is ignored), or null when the path is not one. */
export function tokenFromPath(rawPath: string): string | null {
  const path = rawPath.split('?')[0]
  if (!path.startsWith(WEBHOOK_PATH_PREFIX)) return null
  const token = path.slice(WEBHOOK_PATH_PREFIX.length)
  return TOKEN_PATTERN.test(token) ? token : null
}

/** Headers that may carry the signature; the value is "sha256=<hex>" (GitHub style) or bare hex. */
const SIGNATURE_HEADERS = ['x-orbit-signature', 'x-hub-signature-256']

export function signBody(secret: string, body: Buffer): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

export function verifySignature(secret: string, body: Buffer, headers: Readonly<Record<string, string>>): boolean {
  const header = SIGNATURE_HEADERS.map((name) => headers[name]).find((v) => typeof v === 'string' && v !== '')
  if (!header) return false
  const given = Buffer.from(header.replace(/^sha256=/i, '').trim().toLowerCase(), 'utf8')
  const expected = Buffer.from(signBody(secret, body), 'utf8')
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}

/**
 * Sliding-window limiter: at most `limit` hits per `windowMs` per key. `hit` returns false once
 * the key is over its share (the refused call does not extend the window).
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    // Keys come from outside: keep the map from growing without bound.
    if (this.hits.size > 1000) for (const [k, v] of this.hits) if (v.every((at) => now - at >= this.windowMs)) this.hits.delete(k)
    return true
  }
}

/** Request headers worth showing the agent: they describe the event, they cannot carry credentials. */
const PAYLOAD_HEADERS = ['content-type', 'user-agent', 'x-github-event', 'x-github-delivery', 'x-gitlab-event', 'x-event-key', 'x-request-id']

/**
 * What the agent receives: a JSON text with the arrival time, a few safe headers and the body
 * (parsed when it is JSON, as text otherwise), cut to a fixed size. It is fenced as data by the
 * prompt builder; here it only has to be bounded and well-formed.
 */
export function buildPayload(body: Buffer, headers: Readonly<Record<string, string>>, now: number): string {
  const kept: Record<string, string> = {}
  for (const name of PAYLOAD_HEADERS) if (headers[name]) kept[name] = headers[name].slice(0, 200)
  const text = body.toString('utf8')
  let parsed: unknown = text
  if (/json/i.test(headers['content-type'] ?? '')) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  const make = (value: unknown, cut: boolean): string =>
    JSON.stringify({ receivedAt: new Date(now).toISOString(), headers: kept, body: value, ...(cut ? { truncated: true } : {}) })
  const full = make(parsed, false)
  if (full.length <= WEBHOOK_MAX_PAYLOAD_CHARS) return full
  // Too big as parsed JSON: fall back to the raw text, cut until the whole thing fits.
  const overhead = make('', true).length
  return make(text.slice(0, Math.max(0, WEBHOOK_MAX_PAYLOAD_CHARS - overhead - 40)), true)
}
