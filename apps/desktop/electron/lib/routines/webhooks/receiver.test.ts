import { describe, expect, it } from 'vitest'
import { WEBHOOK_MAX_BODY_BYTES, type Routine, type WebhookDelivery } from '@shared/routines'
import { deriveToken, sha256Hex, signBody } from './guard'
import { createReceiver, type ReceiverDeps, type WebhookRequest } from './receiver'
import type { WebhookRecord } from './store'

const key = Buffer.alloc(32, 1)
const token = deriveToken(key, 'rout_a', 1)
const SECRET = 'shh'

function routine(patch: Partial<Routine> = {}): Routine {
  return { id: 'rout_a', title: 'A', active: true, trigger: { kind: 'webhook' }, ...patch } as Routine
}

function setup(opts: { routine?: Routine; limits?: { perRoutine: number; total: number; unknown: number } } = {}) {
  const log: { delivery: WebhookDelivery; payload?: string }[] = []
  const target = opts.routine ?? routine()
  const record: WebhookRecord = { epoch: 1, tokenHash: sha256Hex(token), secret: SECRET, activity: { routineId: 'rout_a', deliveries: [], pending: [] } }
  let now = 1_000_000
  const deps: ReceiverDeps = {
    now: () => now,
    findByTokenHash: async (hash) => (hash === record.tokenHash ? { routine: target, record } : null),
    record: async (_id, delivery, payload) => void log.push({ delivery, payload }),
  }
  const handle = createReceiver(deps, opts.limits)
  return { handle, log, advance: (ms: number) => (now += ms) }
}

function request(body: string | Buffer, patch: Partial<WebhookRequest> = {}, path = `/hooks/${token}`): WebhookRequest {
  const buf = Buffer.from(body)
  return {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json', 'content-length': String(buf.length) },
    readBody: async (limit) => (buf.length > limit ? null : buf),
    ...patch,
  }
}

describe('webhook receiver', () => {
  it('accepts a call to the right address and keeps a bounded payload', async () => {
    const { handle, log } = setup()
    expect((await handle(request('{"a":1}'))).status).toBe(202)
    expect(log).toHaveLength(1)
    expect(log[0].delivery.accepted).toBe(true)
    expect(JSON.parse(log[0].payload!).body).toEqual({ a: 1 })
  })

  it('answers 404 to a wrong address, a bad path and a paused routine, logging nothing', async () => {
    const wrong = setup()
    expect((await wrong.handle(request('{}', {}, `/hooks/${deriveToken(key, 'other', 1)}`))).status).toBe(404)
    expect((await wrong.handle(request('{}', {}, '/hooks/nope'))).status).toBe(404)
    expect(wrong.log).toHaveLength(0)
    const paused = setup({ routine: routine({ active: false }) })
    expect((await paused.handle(request('{}'))).status).toBe(404)
    const other = setup({ routine: routine({ trigger: { kind: 'schedule' } }) })
    expect((await other.handle(request('{}'))).status).toBe(404)
  })

  it('accepts only POST', async () => {
    const { handle, log } = setup()
    expect((await handle(request('{}', { method: 'GET' }))).status).toBe(405)
    expect(log[0].delivery.accepted).toBe(false)
  })

  it('refuses a body over the cap, declared or streamed, without reading it', async () => {
    const { handle, log } = setup()
    let read = false
    const declared = request('x', { headers: { 'content-length': String(WEBHOOK_MAX_BODY_BYTES + 1) }, readBody: async () => ((read = true), Buffer.from('x')) })
    expect((await handle(declared)).status).toBe(413)
    expect(read).toBe(false)
    const streamed = request('x'.repeat(WEBHOOK_MAX_BODY_BYTES + 1), { headers: {} })
    expect((await handle(streamed)).status).toBe(413)
    expect(log.every((l) => !l.delivery.accepted && l.payload === undefined)).toBe(true)
  })

  it('checks the signature when the routine requires one', async () => {
    const { handle, log } = setup({ routine: routine({ trigger: { kind: 'webhook', signed: true } }) })
    const body = '{"x":1}'
    expect((await handle(request(body))).status).toBe(401)
    expect((await handle(request(body, { headers: { 'x-orbit-signature': 'deadbeef' } }))).status).toBe(401)
    const sig = `sha256=${signBody(SECRET, Buffer.from(body))}`
    expect((await handle(request(body, { headers: { 'x-hub-signature-256': sig } }))).status).toBe(202)
    expect(log.map((l) => l.delivery.accepted)).toEqual([false, false, true])
  })

  it('rate limits one routine without blocking after the window slides', async () => {
    const { handle, advance } = setup({ limits: { perRoutine: 2, total: 100, unknown: 100 } })
    expect((await handle(request('{}'))).status).toBe(202)
    expect((await handle(request('{}'))).status).toBe(202)
    expect((await handle(request('{}'))).status).toBe(429)
    advance(61_000)
    expect((await handle(request('{}'))).status).toBe(202)
  })

  it('rate limits guessing separately from real calls', async () => {
    const { handle } = setup({ limits: { perRoutine: 100, total: 100, unknown: 2 } })
    const guess = request('{}', {}, `/hooks/${deriveToken(key, 'x', 9)}`)
    expect((await handle(guess)).status).toBe(404)
    expect((await handle(guess)).status).toBe(404)
    expect((await handle(guess)).status).toBe(429)
    expect((await handle(request('{}'))).status).toBe(202)
  })

  it('caps the whole listener', async () => {
    const { handle } = setup({ limits: { perRoutine: 100, total: 1, unknown: 100 } })
    expect((await handle(request('{}'))).status).toBe(202)
    expect((await handle(request('{}'))).status).toBe(429)
  })
})
