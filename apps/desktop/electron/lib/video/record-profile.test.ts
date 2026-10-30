import { describe, expect, it } from 'vitest'
import { describeProfile, resolveRecordProfile } from './record-profile'

describe('resolveRecordProfile', () => {
  it('on a strong machine, the automatic default is 60 fps at high quality', () => {
    const profile = resolveRecordProfile({}, 'strong')
    expect(profile.quality).toBe('high')
    expect(profile.fps).toBe(60)
    expect(profile.explicit).toBe(false)
  })

  it('on a weak machine, the automatic default drops to 30 fps and low quality', () => {
    const profile = resolveRecordProfile({}, 'weak')
    expect(profile.quality).toBe('low')
    expect(profile.fps).toBe(30)
    expect(profile.crf).toBeGreaterThan(resolveRecordProfile({}, 'strong').crf)
  })

  it('a balanced machine stays in the middle', () => {
    expect(resolveRecordProfile({}, 'balanced').quality).toBe('medium')
  })

  it('the requested level WINS over the machine: high quality on a weak machine stays high', () => {
    const profile = resolveRecordProfile({ quality: 'high' }, 'weak')
    expect(profile.quality).toBe('high')
    expect(profile.fps).toBe(60)
    expect(profile.explicit).toBe(true)
  })

  it('max on a weak machine is also respected', () => {
    const profile = resolveRecordProfile({ quality: 'max' }, 'weak')
    expect(profile.quality).toBe('max')
    expect(profile.crf).toBe(14)
  })

  it('a requested low on a strong machine is not promoted to high', () => {
    const profile = resolveRecordProfile({ quality: 'low' }, 'strong')
    expect(profile.quality).toBe('low')
    expect(profile.fps).toBe(30)
  })

  it('an explicit fps wins over the profile', () => {
    expect(resolveRecordProfile({ quality: 'high', fps: 24 }, 'strong').fps).toBe(24)
    expect(resolveRecordProfile({ quality: 'low', fps: 60 }, 'weak').fps).toBe(60)
  })

  it('an explicit crf wins over the profile', () => {
    expect(resolveRecordProfile({ quality: 'max', crf: 30 }, 'strong').crf).toBe(30)
  })

  it('values out of range are clamped, they do not blow up ffmpeg', () => {
    expect(resolveRecordProfile({ fps: 1000 }, 'strong').fps).toBe(60)
    expect(resolveRecordProfile({ fps: 1 }, 'strong').fps).toBe(10)
    expect(resolveRecordProfile({ crf: 0 }, 'strong').crf).toBe(12)
    expect(resolveRecordProfile({ crf: 99 }, 'strong').crf).toBe(34)
  })

  it('better profiles never record worse than the worst ones', () => {
    const low = resolveRecordProfile({ quality: 'low' }, 'weak')
    const medium = resolveRecordProfile({ quality: 'medium' }, 'weak')
    const high = resolveRecordProfile({ quality: 'high' }, 'weak')
    const max = resolveRecordProfile({ quality: 'max' }, 'weak')
    expect(max.crf).toBeLessThan(high.crf)
    expect(high.crf).toBeLessThan(medium.crf)
    expect(medium.crf).toBeLessThan(low.crf)
    expect(max.maxWidth).toBeGreaterThanOrEqual(high.maxWidth)
  })
})

describe('describeProfile', () => {
  it('distinguishes what was requested from what came from the machine', () => {
    expect(describeProfile(resolveRecordProfile({}, 'strong'), 'strong')).toContain('auto · machine strong')
    expect(describeProfile(resolveRecordProfile({ quality: 'max' }, 'weak'), 'weak')).toContain('requested')
  })
})
