import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '@shared/chat'

// The module pulls the engine and the companion server; here only the rule matters.
vi.mock('./chat-engine', () => ({ getRunningSessionIds: () => [] }))
vi.mock('./companion-server', () => ({ broadcastSessionEvent: vi.fn() }))
vi.mock('./storage', () => ({ listKeys: vi.fn(), readJson: vi.fn(), writeJson: vi.fn() }))

const { staleSessions } = await import('./auto-archive')

const DAY = 24 * 60 * 60 * 1000
const now = 100 * DAY
const session = (id: string, daysIdle: number, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, title: id, mode: 'chat', pinned: false, archived: false, createdAt: 0, updatedAt: now - daysIdle * DAY, ...extra }) as SessionInfo

describe('staleSessions', () => {
  const sessions = [
    session('old one', 40),
    session('recente', 5),
    session('fixada', 40, { pinned: true }),
    session('already-archived', 40, { archived: true }),
    session('routine', 40, { routineId: 'r1' }),
    session('worker', 40, { parentId: 'pai' }),
    session('running', 40),
  ]

  it('only archives what the user set aside', () => {
    const stale = staleSessions(sessions, 30, now, new Set(['running']))
    expect(stale.map((s) => s.id)).toEqual(['old one'])
  })

  it('the chosen deadline decides', () => {
    expect(staleSessions(sessions, 3, now, new Set()).map((s) => s.id)).toContain('recente')
  })
})
