import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const userData = path.join(os.tmpdir(), `orbit-offers-test-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

let offers: typeof import('./specialist-offers')

beforeAll(async () => {
  offers = await import('./specialist-offers')
})
afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('specialist offers', () => {
  it('remembers a decision per conversation and craft', async () => {
    expect(await offers.offerDecided('chat-a', 'motion')).toBe(false)
    await offers.recordOfferDecision('chat-a', 'motion')
    expect(await offers.offerDecided('chat-a', 'motion')).toBe(true)
    expect(await offers.offerDecided('chat-a', 'design')).toBe(false)
    expect(await offers.offerDecided('chat-b', 'motion')).toBe(false)
  })

  it('keeps every craft when answers arrive together, and survives a reload from disk', async () => {
    await Promise.all([offers.recordOfferDecision('chat-c', 'motion'), offers.recordOfferDecision('chat-c', 'design'), offers.recordOfferDecision('chat-c', 'motion')])
    // A fresh module instance has no memory of the above: only the file.
    vi.resetModules()
    const fresh = await import('./specialist-offers')
    expect(await fresh.offerDecided('chat-c', 'motion')).toBe(true)
    expect(await fresh.offerDecided('chat-c', 'design')).toBe(true)
    expect(await fresh.offerDecided('chat-c', 'fragment')).toBe(false)
  })
})
