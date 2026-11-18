import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '@orbit/shared'
import { dayKey, lastSessionForStart } from './start-screen'

const session = (over: Partial<SessionInfo> & { id: string }): SessionInfo =>
  ({ title: over.id, mode: 'chat', pinned: false, archived: false, folderId: null, updatedAt: 1, createdAt: 1, ...over }) as SessionInfo

describe('start screen', () => {
  it('writes the day as YYYY-MM-DD in local time', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(dayKey(new Date(2026, 10, 18))).toBe('2026-11-18')
  })

  it('resumes the most recent chat of the same mode', () => {
    const sessions = [session({ id: 'a', updatedAt: 1 }), session({ id: 'b', updatedAt: 5 }), session({ id: 'c', mode: 'code', updatedAt: 9 })]
    expect(lastSessionForStart(sessions, { mode: 'chat' })?.id).toBe('b')
  })

  it('skips archived, sub-agent and the open session', () => {
    const sessions = [
      session({ id: 'open', updatedAt: 9 }),
      session({ id: 'old', archived: true, updatedAt: 8 }),
      session({ id: 'child', parentId: 'open', updatedAt: 7 }),
      session({ id: 'prev', updatedAt: 2 }),
    ]
    expect(lastSessionForStart(sessions, { mode: 'chat', currentId: 'open' })?.id).toBe('prev')
  })

  it('in code only offers a session of the open folder', () => {
    const sessions = [session({ id: 'x', mode: 'code', directory: '/a', updatedAt: 9 }), session({ id: 'y', mode: 'code', directory: '/b', updatedAt: 1 })]
    expect(lastSessionForStart(sessions, { mode: 'code', directory: '/b' })?.id).toBe('y')
    expect(lastSessionForStart(sessions, { mode: 'code', directory: '/c' })).toBeUndefined()
  })

  it('offers nothing when there is no other chat', () => {
    expect(lastSessionForStart([], { mode: 'chat' })).toBeUndefined()
  })
})
