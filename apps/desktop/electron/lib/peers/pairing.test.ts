import { describe, expect, it } from 'vitest'
import { PendingPairs, pairingCode, sanitizePeerName } from './pairing'
import { classifyDesktopRequest, desktopMayRequest } from './permissions'
import { NO_GRANTS, parseRemoteSessionId, remoteSessionId } from '@shared/peers'

describe('pairing code', () => {
  const base = {
    requesterFingerprint: 'AA:BB',
    responderFingerprint: 'CC:DD',
    requesterNonce: '1'.repeat(64),
    responderNonce: '2'.repeat(64),
  }
  it('is six digits and the same for both sides', () => {
    const code = pairingCode(base)
    expect(code).toMatch(/^\d{6}$/)
    expect(pairingCode({ ...base, requesterFingerprint: 'aabb' })).toBe(code)
  })
  it('changes with any input', () => {
    const code = pairingCode(base)
    expect(pairingCode({ ...base, responderNonce: '3'.repeat(64) })).not.toBe(code)
    expect(pairingCode({ ...base, responderFingerprint: 'CC:DE' })).not.toBe(code)
  })
})

describe('pending pairs', () => {
  it('limits per IP, caps the queue and replaces a retry from the same peer', () => {
    let now = 1000
    const pairs = new PendingPairs<null>({ maxPending: 2, perIpWindowMs: 100, ttlMs: 500, now: () => now })
    const a = pairs.add({ peerId: 'p_a', fingerprint: 'f', ip: '1', payload: null })
    expect(a.ok).toBe(true)
    expect(pairs.add({ peerId: 'p_b', fingerprint: 'f', ip: '1', payload: null })).toEqual({ ok: false, reason: 'rate_limited' })
    expect(pairs.add({ peerId: 'p_b', fingerprint: 'f', ip: '2', payload: null }).ok).toBe(true)
    expect(pairs.add({ peerId: 'p_c', fingerprint: 'f', ip: '3', payload: null })).toEqual({ ok: false, reason: 'busy' })
    now += 200
    const retry = pairs.add({ peerId: 'p_a', fingerprint: 'f', ip: '1', payload: null })
    expect(retry.ok && retry.replaced?.peerId).toBe('p_a')
    expect(pairs.list()).toHaveLength(2)
  })

  it('expires and is consumed by take', () => {
    let now = 0
    const pairs = new PendingPairs<null>({ ttlMs: 50, now: () => now })
    const r = pairs.add({ peerId: 'p_a', fingerprint: 'f', ip: '1', payload: null })
    if (!r.ok) throw new Error('should add')
    expect(pairs.take(r.item.requestId)?.peerId).toBe('p_a')
    expect(pairs.take(r.item.requestId)).toBeNull()
    const r2 = pairs.add({ peerId: 'p_b', fingerprint: 'f', ip: '2', payload: null })
    if (!r2.ok) throw new Error('should add')
    now = 100
    expect(pairs.sweep().map((p) => p.peerId)).toEqual(['p_b'])
    expect(pairs.take(r2.item.requestId)).toBeNull()
  })
})

describe('desktop permissions', () => {
  const readOnly = { control: false, send: true, files: true }
  const full = { control: true, send: false, files: false }
  const deniedUnderControl = [
    'memory:list',
    'memory:delete',
    'prefs:set',
    'worker-config:set',
    'git:checkout',
    'git:branches',
    'sessions:delete',
    'sessions:revert',
    'sessions:move-folder',
    'folders:delete',
    'routines:create',
    'pipeline:start-task',
    'ask:reply',
    'plan:review-accept',
    'orchestration:approve',
    'models:select',
    'queue:op',
    'something:new',
  ]

  it('a read-only pairing cannot touch settings, git, memory or approvals', () => {
    for (const type of ['fs:list-dirs', ...deniedUnderControl]) {
      expect(desktopMayRequest(type, readOnly), type).toBe(false)
    }
  })

  it('full control is the phone surface — everything except the project files', () => {
    for (const type of deniedUnderControl) {
      expect(desktopMayRequest(type, full), type).toBe(true)
    }
    expect(desktopMayRequest('fs:read', full)).toBe(false)
    expect(desktopMayRequest('fs:read', { ...full, files: true })).toBe(true)
  })

  it('viewing needs no grant; sending comes with control or its own grant', () => {
    expect(desktopMayRequest('messages:get', NO_GRANTS)).toBe(true)
    expect(desktopMayRequest('piece:resolve', NO_GRANTS)).toBe(true)
    expect(desktopMayRequest('messages:send', NO_GRANTS)).toBe(false)
    expect(desktopMayRequest('messages:send', { control: false, send: true, files: false })).toBe(true)
    expect(desktopMayRequest('messages:send', full)).toBe(true)
    // The settings snapshot and the queue are control: a send-only peer cannot read or change them.
    expect(desktopMayRequest('sync:get', { control: false, send: true, files: false })).toBe(false)
    expect(desktopMayRequest('queue:op', { control: false, send: true, files: false })).toBe(false)
    expect(desktopMayRequest('sync:get', full)).toBe(true)
    expect(desktopMayRequest('fs:read', { control: false, send: true, files: false })).toBe(false)
    expect(desktopMayRequest('fs:read', { control: false, send: false, files: true })).toBe(true)
    expect(classifyDesktopRequest('chat:abort')).toBe('send')
  })
})

describe('remote session ids', () => {
  it('round-trips and rejects anything else', () => {
    const id = remoteSessionId('p_0123456789abcdef', 'abc:def')
    expect(parseRemoteSessionId(id)).toEqual({ peerId: 'p_0123456789abcdef', sessionId: 'abc:def' })
    expect(parseRemoteSessionId('abc')).toBeNull()
    expect(parseRemoteSessionId('peer:nothex:abc')).toBeNull()
    expect(parseRemoteSessionId('peer:p_0123456789abcdef:')).toBeNull()
  })
  it('sanitizes names', () => {
    expect(sanitizePeerName('  <b>Ana</b>\n ')).toBe('bAna/b')
    expect(sanitizePeerName(42)).toBe('Orbit')
  })
})
