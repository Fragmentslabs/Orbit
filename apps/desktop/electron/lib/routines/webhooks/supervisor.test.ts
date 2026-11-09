import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_FIRE_GAP_MS, type Routine, type WebhookActivity } from '@shared/routines'
import type { WebhookRecord } from './store'

let stored: WebhookRecord | null = null
vi.mock('./store', () => ({
  readWebhookRecord: async () => stored,
  writeWebhookRecord: async (_id: string, record: WebhookRecord) => void (stored = record),
}))

import { drainWebhook } from './supervisor'

const routine = { id: 'rout_a', title: 'A', active: true, trigger: { kind: 'webhook' } } as Routine
const activity = (patch: Partial<WebhookActivity> = {}): WebhookActivity => ({ routineId: 'rout_a', deliveries: [], pending: [], ...patch })

function deps(over: { running?: boolean; start?: string | null } = {}) {
  const startRun = vi.fn(async (_r: Routine, _p: string[]) => (over.start === undefined ? 'session' : over.start))
  const seen: WebhookActivity[] = []
  return { startRun, seen, d: { startRun, isRunning: () => !!over.running, onActivity: (a: WebhookActivity) => void seen.push(a) } }
}

beforeEach(() => {
  stored = { epoch: 1, tokenHash: 'h', activity: activity({ pending: ['{"a":1}', '{"b":2}'] }) }
})

describe('drainWebhook', () => {
  it('hands every waiting payload to one run and clears them', async () => {
    const { d, startRun, seen } = deps()
    expect(await drainWebhook(routine, d, 5_000_000)).toBe(true)
    expect(startRun).toHaveBeenCalledWith(routine, ['{"a":1}', '{"b":2}'])
    expect(stored?.activity.pending).toEqual([])
    expect(stored?.activity.lastFireAt).toBe(5_000_000)
    expect(seen).toHaveLength(1)
  })
  it('keeps them while the routine is busy or the run could not start', async () => {
    expect(await drainWebhook(routine, deps({ running: true }).d)).toBe(false)
    expect(await drainWebhook(routine, deps({ start: null }).d)).toBe(false)
    expect(stored?.activity.pending).toHaveLength(2)
  })
  it('waits for the fire gap since the last run', async () => {
    stored = { ...stored!, activity: activity({ pending: ['x'], lastFireAt: 1_000_000 }) }
    const { d, startRun } = deps()
    expect(await drainWebhook(routine, d, 1_000_000 + MIN_FIRE_GAP_MS - 1)).toBe(false)
    expect(startRun).not.toHaveBeenCalled()
    expect(await drainWebhook(routine, d, 1_000_000 + MIN_FIRE_GAP_MS)).toBe(true)
  })
  it('does nothing for a paused routine or without payloads', async () => {
    expect(await drainWebhook({ ...routine, active: false }, deps().d)).toBe(false)
    stored = { ...stored!, activity: activity() }
    expect(await drainWebhook(routine, deps().d)).toBe(false)
  })
})
