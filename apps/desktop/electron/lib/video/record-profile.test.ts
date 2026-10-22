import { describe, expect, it } from 'vitest'
import { describeProfile, resolveRecordProfile } from './record-profile'

describe('resolveRecordProfile', () => {
  it('em máquina forte, o padrão automático é 60 fps em qualidade alta', () => {
    const profile = resolveRecordProfile({}, 'strong')
    expect(profile.quality).toBe('high')
    expect(profile.fps).toBe(60)
    expect(profile.explicit).toBe(false)
  })

  it('em máquina fraca, o padrão automático desce para 30 fps e qualidade baixa', () => {
    const profile = resolveRecordProfile({}, 'weak')
    expect(profile.quality).toBe('low')
    expect(profile.fps).toBe(30)
    expect(profile.crf).toBeGreaterThan(resolveRecordProfile({}, 'strong').crf)
  })

  it('máquina equilibrada fica no meio', () => {
    expect(resolveRecordProfile({}, 'balanced').quality).toBe('medium')
  })

  it('o nível pedido VENCE a máquina: qualidade alta em máquina fraca continua alta', () => {
    const profile = resolveRecordProfile({ quality: 'high' }, 'weak')
    expect(profile.quality).toBe('high')
    expect(profile.fps).toBe(60)
    expect(profile.explicit).toBe(true)
  })

  it('max em máquina fraca também é respeitado', () => {
    const profile = resolveRecordProfile({ quality: 'max' }, 'weak')
    expect(profile.quality).toBe('max')
    expect(profile.crf).toBe(14)
  })

  it('low pedido em máquina forte não é promovido para high', () => {
    const profile = resolveRecordProfile({ quality: 'low' }, 'strong')
    expect(profile.quality).toBe('low')
    expect(profile.fps).toBe(30)
  })

  it('fps explícito vence o perfil', () => {
    expect(resolveRecordProfile({ quality: 'high', fps: 24 }, 'strong').fps).toBe(24)
    expect(resolveRecordProfile({ quality: 'low', fps: 60 }, 'weak').fps).toBe(60)
  })

  it('crf explícito vence o perfil', () => {
    expect(resolveRecordProfile({ quality: 'max', crf: 30 }, 'strong').crf).toBe(30)
  })

  it('valores fora da faixa são presos ao limite, não estouram o ffmpeg', () => {
    expect(resolveRecordProfile({ fps: 1000 }, 'strong').fps).toBe(60)
    expect(resolveRecordProfile({ fps: 1 }, 'strong').fps).toBe(10)
    expect(resolveRecordProfile({ crf: 0 }, 'strong').crf).toBe(12)
    expect(resolveRecordProfile({ crf: 99 }, 'strong').crf).toBe(34)
  })

  it('perfis melhores nunca gravam pior que os piores', () => {
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
  it('distingue o que foi pedido do que veio da máquina', () => {
    expect(describeProfile(resolveRecordProfile({}, 'strong'), 'strong')).toContain('auto · máquina strong')
    expect(describeProfile(resolveRecordProfile({ quality: 'max' }, 'weak'), 'weak')).toContain('pedido')
  })
})
