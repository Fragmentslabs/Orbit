import { describe, expect, it } from 'vitest'
import { createRegistry, OBSERVATION_TTL_MS, type ObservationRecord } from './registry'

function record(over: Partial<ObservationRecord> = {}): ObservationRecord {
  return {
    id: 'obs_1',
    sessionId: 's1',
    createdAt: 0,
    app: { pid: 10, bundleId: 'com.apple.Safari', name: 'Safari', active: true, hidden: false },
    window: { id: 5, pid: 10, title: 'Banco', frame: [0, 0, 100, 100] },
    geometry: { frame: [0, 0, 100, 100], width: 100, height: 100 },
    hasScreenshot: true,
    url: 'https://banco.com.br/',
    elements: new Map([[3, { index: 3, path: [0, 1], role: 'AXButton', title: 'Pagar', frame: [1, 1, 10, 10], actions: ['AXPress'], secure: false }]]),
    digest: null,
    ...over,
  }
}

describe('registry', () => {
  it('ação resolve contra a observação mais recente do app', () => {
    const r = createRegistry(() => 0)
    r.record(record())
    const obs = r.forAction('s1', 10)
    expect(r.element(obs, 3).title).toBe('Pagar')
  })

  it('observação nova invalida os índices da anterior', () => {
    const r = createRegistry(() => 0)
    r.record(record({ id: 'obs_1' }))
    r.record(record({ id: 'obs_2', elements: new Map() }))
    expect(() => r.forAction('s1', 10, 'obs_1')).toThrow(/not the latest/)
    const latest = r.forAction('s1', 10)
    expect(() => r.element(latest, 3)).toThrow(/does not exist/)
  })

  it('vence depois do TTL', () => {
    let now = 0
    const r = createRegistry(() => now)
    r.record(record())
    now = OBSERVATION_TTL_MS + 1
    expect(() => r.forAction('s1', 10)).toThrow(/expired/)
  })

  it('sem observação do app, manda observar antes', () => {
    const r = createRegistry(() => 0)
    expect(() => r.forAction('s1', 99)).toThrow(/cu_observe first/)
  })

  it('sessões não enxergam as observações umas das outras', () => {
    const r = createRegistry(() => 0)
    r.record(record())
    expect(() => r.forAction('outra', 10)).toThrow(/cu_observe first/)
  })

  it('lastTargetFor acha o app por bundle, nome ou pid (para o gate pedir por site)', () => {
    const r = createRegistry(() => 0)
    r.record(record())
    expect(r.lastTargetFor('com.apple.Safari')?.url).toBe('https://banco.com.br/')
    expect(r.lastTargetFor('safari')?.bundleId).toBe('com.apple.Safari')
    expect(r.lastTargetFor('10')?.name).toBe('Safari')
    expect(r.lastTargetFor('Notes')).toBeNull()
  })
})
