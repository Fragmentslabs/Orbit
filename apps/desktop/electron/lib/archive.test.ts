import { describe, expect, it } from 'vitest'
import { planArchivedCleanup, setArchivedState } from '@shared/archive'
import type { SessionInfo } from '@shared/chat'

const DAY = 24 * 60 * 60 * 1000
const now = 100 * DAY
const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, title: id, mode: 'chat', pinned: false, archived: true, folderId: null, createdAt: 0, updatedAt: 0, ...extra }) as SessionInfo

describe('setArchivedState', () => {
  it('archiving dates the archival; unarchiving clears the date', () => {
    const archived = setArchivedState(session('a', { archived: false }), true, now)
    expect(archived).toMatchObject({ archived: true, archivedAt: now })
    expect(setArchivedState(archived, false, now + DAY)).toMatchObject({ archived: false, archivedAt: null })
  })

  it('with no state change, the original date stays', () => {
    const archived = session('a', { archivedAt: now - 5 * DAY })
    expect(setArchivedState(archived, true, now)).toBe(archived)
  })
})

describe('planArchivedCleanup', () => {
  it('counts the deadline from the archival, not from the last activity', () => {
    // Stopped 90 days ago, but archived yesterday: it does not leave yet.
    const recent = session('recent', { updatedAt: now - 90 * DAY, archivedAt: now - DAY })
    const oldSession = session('old-one', { archivedAt: now - 31 * DAY })
    const { expired } = planArchivedCleanup([recent, oldSession], 30, now, new Set())
    expect(expired.map((s) => s.id)).toEqual(['old-one'])
  })

  it('leaves out pinned ones, those answering, workers and non-archived ones', () => {
    const old = { archivedAt: now - 60 * DAY }
    const sessions = [
      session('sai', old),
      session('fixada', { ...old, pinned: true }),
      session('running', old),
      session('worker', { ...old, parentId: 'pai' }),
      session('active', { ...old, archived: false }),
    ]
    const { expired } = planArchivedCleanup(sessions, 30, now, new Set(['running']))
    expect(expired.map((s) => s.id)).toEqual(['sai'])
  })

  it('archived before the date existed start counting now, without leaving all at once', () => {
    const { expired, undated } = planArchivedCleanup([session('no-date', { updatedAt: now - 365 * DAY })], 7, now, new Set())
    expect(expired).toEqual([])
    expect(undated.map((s) => s.id)).toEqual(['no-date'])
  })
})
