import { describe, expect, it } from 'vitest'
import { cleanWorktreeName, shortAge, shortHash, syncErrorKey } from './git-format'

describe('syncErrorKey', () => {
  it('words each failure by its kind', () => {
    expect(syncErrorKey('push', { ok: false, kind: 'auth' })).toBe('project.sync.auth')
    expect(syncErrorKey('push', { ok: false, kind: 'noRemote' })).toBe('project.sync.noRemote')
    expect(syncErrorKey('pull', { ok: false, kind: 'noUpstream' })).toBe('project.sync.noUpstream')
    expect(syncErrorKey('push', { ok: false, kind: 'noUpstream' })).toBe('project.sync.failed')
    expect(syncErrorKey('pull', { ok: false })).toBe('project.sync.failed')
  })
})

describe('shortAge', () => {
  const now = Date.parse('2026-11-23T12:00:00Z')
  it('compacts the age of a commit', () => {
    expect(shortAge('2026-11-23T11:59:30Z', now)).toBe('now')
    expect(shortAge('2026-11-23T11:30:00Z', now)).toBe('30m')
    expect(shortAge('2026-11-23T07:00:00Z', now)).toBe('5h')
    expect(shortAge('2026-11-20T12:00:00Z', now)).toBe('3d')
    expect(shortAge('2026-11-02T12:00:00Z', now)).toBe('3w')
    expect(shortAge('2026-05-23T12:00:00Z', now)).toBe('6mo')
    expect(shortAge('2024-11-23T12:00:00Z', now)).toBe('2y')
    expect(shortAge('garbage', now)).toBe('')
  })
})

describe('names', () => {
  it('cleans a worktree name and shortens a hash', () => {
    expect(cleanWorktreeName('  my  fix ')).toBe('my-fix')
    expect(shortHash('0123456789abcdef')).toBe('0123456')
  })
})
