import { WEBHOOK_MAX_BODY_BYTES, type Routine, type WebhookDelivery } from '@shared/routines'
import { buildPayload, RateLimiter, sha256Hex, tokenFromPath, verifySignature } from './guard'
import type { WebhookRecord } from './store'

/**
 * The decisions of the webhook receiver, written against a tiny request layer instead of Node's
 * sockets so they are tested without opening a port. Order matters: the cheapest and least
 * informative refusals come first, and an address that does not exist is always a plain 404.
 */

export interface WebhookRequest {
  method: string
  /** Path and query, as sent. */
  path: string
  /** Lower-case names, one string per header. */
  headers: Readonly<Record<string, string>>
  /** The whole body, or null when it is bigger than `limit` (the rest is not read). */
  readBody(limit: number): Promise<Buffer | null>
}

export interface WebhookResponse {
  status: number
  body: string
}

export interface WebhookTarget {
  routine: Routine
  record: WebhookRecord
}

export interface ReceiverDeps {
  now(): number
  /** The routine whose current address hashes to this, if any. */
  findByTokenHash(hash: string): Promise<WebhookTarget | null>
  /** Keeps the call in the routine's log and, when accepted, its payload for the next run. */
  record(routineId: string, delivery: WebhookDelivery, payload?: string): Promise<void>
}

export interface ReceiverLimits {
  /** Calls per minute to one routine. */
  perRoutine: number
  /** Calls per minute to the whole listener. */
  total: number
  /** Calls per minute to addresses that do not exist (guessing). */
  unknown: number
}

export const DEFAULT_RECEIVER_LIMITS: ReceiverLimits = { perRoutine: 20, total: 120, unknown: 30 }

const WINDOW_MS = 60_000

function reply(status: number, message: string): WebhookResponse {
  return { status, body: JSON.stringify(status < 300 ? { ok: true, message } : { ok: false, error: message }) }
}

export function createReceiver(deps: ReceiverDeps, limits: ReceiverLimits = DEFAULT_RECEIVER_LIMITS) {
  const total = new RateLimiter(limits.total, WINDOW_MS)
  const perRoutine = new RateLimiter(limits.perRoutine, WINDOW_MS)
  const unknown = new RateLimiter(limits.unknown, WINDOW_MS)

  return async function handle(req: WebhookRequest): Promise<WebhookResponse> {
    const now = deps.now()
    const token = tokenFromPath(req.path)
    if (!token) return reply(404, 'Not found.')
    if (!total.hit('all', now)) return reply(429, 'Too many requests.')

    const target = await deps.findByTokenHash(sha256Hex(token))
    if (!target || !target.routine.active || target.routine.trigger?.kind !== 'webhook') {
      // A guess and a paused routine look the same from outside.
      if (!unknown.hit('unknown', now)) return reply(429, 'Too many requests.')
      return reply(404, 'Not found.')
    }
    const { routine, record } = target
    const refuse = async (status: number, error: string, bytes = 0): Promise<WebhookResponse> => {
      await deps.record(routine.id, { at: now, accepted: false, error, bytes })
      return reply(status, error)
    }

    if (req.method !== 'POST') return refuse(405, 'Only POST is accepted.')
    if (!perRoutine.hit(routine.id, now)) return refuse(429, 'Too many requests to this routine.')
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > WEBHOOK_MAX_BODY_BYTES) return refuse(413, 'The body is too large.')
    const body = await req.readBody(WEBHOOK_MAX_BODY_BYTES)
    if (!body) return refuse(413, 'The body is too large.')

    if (routine.trigger?.kind === 'webhook' && routine.trigger.signed) {
      if (!record.secret || !verifySignature(record.secret, body, req.headers)) {
        return refuse(401, 'The signature is missing or does not match.', body.length)
      }
    }

    await deps.record(routine.id, { at: now, accepted: true, bytes: body.length }, buildPayload(body, req.headers, now))
    return reply(202, 'Accepted.')
  }
}
