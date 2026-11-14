import { describe, expect, it } from 'vitest'
import { receivesChannel, type SyncChannel } from './client-capabilities'

const CHANNELS: SyncChannel[] = ['work', 'memory', 'sync', 'notify']

describe('receivesChannel', () => {
  it('sends the phone everything except memory', () => {
    for (const ch of CHANNELS) expect(receivesChannel({ kind: 'phone' }, ch)).toBe(ch !== 'memory')
  })

  it('sends a full-control desktop every channel', () => {
    for (const ch of CHANNELS) expect(receivesChannel({ kind: 'desktop', grants: { control: true } }, ch)).toBe(true)
  })

  it('sends a view-only desktop nothing', () => {
    for (const ch of CHANNELS) {
      expect(receivesChannel({ kind: 'desktop', grants: { control: false } }, ch)).toBe(false)
      expect(receivesChannel({ kind: 'desktop' }, ch)).toBe(false)
    }
  })

  it('ignores grants on a phone and unknown kinds', () => {
    expect(receivesChannel({ kind: 'phone', grants: { control: true } }, 'memory')).toBe(false)
    expect(receivesChannel({ kind: 'other', grants: { control: true } }, 'work')).toBe(false)
  })
})
