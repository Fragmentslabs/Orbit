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
  it('an action resolves against the latest observation of the app', () => {
    const r = createRegistry(() => 0)
    r.record(record())
    const obs = r.forAction('s1', 10)
    expect(r.element(obs, 3).title).toBe('Pagar')
  })

  it('a new observation invalidates the previous indexes', () => {
    const r = createRegistry(() => 0)
    r.record(record({ id: 'obs_1' }))
    r.record(record({ id: 'obs_2', elements: new Map() }))
    expect(() => r.forAction('s1', 10, 'obs_1')).toThrow(/not the latest/)
    const latest = r.forAction('s1', 10)
    expect(() => r.element(latest, 3)).toThrow(/does not exist/)
  })

  it('expires after the TTL', () => {
    let now = 0
    const r = createRegistry(() => now)
    r.record(record())
    now = OBSERVATION_TTL_MS + 1
    expect(() => r.forAction('s1', 10)).toThrow(/expired/)
  })

  it('with no observation of the app, it tells you to observe first', () => {
    const r = createRegistry(() => 0)
    expect(() => r.forAction('s1', 99)).toThrow(/cu_observe first/)
  })

  it('sessions do not see the observations of other sessions', () => {
    const r = createRegistry(() => 0)
    r.record(record())
    expect(() => r.forAction('outra', 10)).toThrow(/cu_observe first/)
  })

  it('lastTargetFor finds the app by bundle, name or pid (so the gate can ask by site)', () => {
    const r = createRegistry(() => 0)
    r.record(record())
    expect(r.lastTargetFor('com.apple.Safari')?.url).toBe('https://banco.com.br/')
    expect(r.lastTargetFor('safari')?.bundleId).toBe('com.apple.Safari')
    expect(r.lastTargetFor('10')?.name).toBe('Safari')
    expect(r.lastTargetFor('Notes')).toBeNull()
  })
})
