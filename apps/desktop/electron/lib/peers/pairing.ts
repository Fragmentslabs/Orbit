import { createHash, randomBytes } from 'node:crypto'
import { PEER_PAIR_TTL_MS } from '@shared/peers'

/**
 * Pairing between desktops, the parts without network or Electron (tested).
 *
 * The code on both screens is derived from the two certificates that the TLS
 * handshake itself presented, plus a nonce from each side. A machine in the middle
 * would have to present its own certificate to each side, so each side would
 * compute a different code — the people comparing the screens see the mismatch
 * and decline. Nonces from both sides keep the code fresh on every attempt.
 */
export function pairingCode(input: {
  requesterFingerprint: string
  responderFingerprint: string
  requesterNonce: string
  responderNonce: string
}): string {
  const digest = createHash('sha256')
    .update(
      [
        'orbit-pair-v1',
        normalizeFingerprint(input.requesterFingerprint),
        normalizeFingerprint(input.responderFingerprint),
        input.requesterNonce,
        input.responderNonce,
      ].join('|'),
    )
    .digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^a-fA-F0-9]/g, '').toUpperCase()
}

export function newNonce(): string {
  return randomBytes(32).toString('hex')
}

export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/** Name shown on the other screen: printable, short, never empty. */
export function sanitizePeerName(value: unknown): string {
  const raw = typeof value === 'string' ? value : ''
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 64)
  return clean || 'Orbit'
}

export interface PendingPair<T> {
  requestId: string
  peerId: string
  fingerprint: string
  ip: string
  createdAt: number
  expiresAt: number
  payload: T
}

/**
 * Requests waiting for the person at this machine.
 *
 * Limits, all of them against a noisy or hostile neighbor on the network:
 * - at most `maxPending` waiting at once;
 * - one new request per IP per `perIpWindowMs`;
 * - a new request from the same peer REPLACES its previous one (a retry does not
 *   stack cards);
 * - each one expires after `ttlMs`.
 */
export class PendingPairs<T> {
  private readonly items = new Map<string, PendingPair<T>>()
  private readonly lastByIp = new Map<string, number>()

  constructor(
    private readonly opts: { maxPending?: number; perIpWindowMs?: number; ttlMs?: number; now?: () => number } = {},
  ) {}

  private now() {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  /** Drops the expired ones and returns them (the caller tells their sockets). */
  sweep(): PendingPair<T>[] {
    const now = this.now()
    const expired: PendingPair<T>[] = []
    for (const [id, item] of this.items) {
      if (item.expiresAt <= now) {
        this.items.delete(id)
        expired.push(item)
      }
    }
    return expired
  }

  add(
    input: { peerId: string; fingerprint: string; ip: string; payload: T },
  ): { ok: true; item: PendingPair<T>; replaced?: PendingPair<T> } | { ok: false; reason: 'rate_limited' | 'busy' } {
    this.sweep()
    const now = this.now()
    const window = this.opts.perIpWindowMs ?? 5_000
    const last = this.lastByIp.get(input.ip)
    if (last !== undefined && now - last < window) return { ok: false, reason: 'rate_limited' }

    const previous = [...this.items.values()].find((i) => i.peerId === input.peerId)
    if (!previous && this.items.size >= (this.opts.maxPending ?? 3)) return { ok: false, reason: 'busy' }
    if (previous) this.items.delete(previous.requestId)

    this.lastByIp.set(input.ip, now)
    const item: PendingPair<T> = {
      requestId: randomBytes(12).toString('hex'),
      peerId: input.peerId,
      fingerprint: input.fingerprint,
      ip: input.ip,
      createdAt: now,
      expiresAt: now + (this.opts.ttlMs ?? PEER_PAIR_TTL_MS),
      payload: input.payload,
    }
    this.items.set(item.requestId, item)
    return previous ? { ok: true, item, replaced: previous } : { ok: true, item }
  }

  /** Removes and returns the request — accept and decline both consume it. */
  take(requestId: string): PendingPair<T> | null {
    this.sweep()
    const item = this.items.get(requestId) ?? null
    if (item) this.items.delete(requestId)
    return item
  }

  remove(requestId: string): void {
    this.items.delete(requestId)
  }

  list(): PendingPair<T>[] {
    this.sweep()
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt)
  }
}
