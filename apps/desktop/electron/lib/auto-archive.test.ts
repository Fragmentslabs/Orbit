import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '@shared/chat'

// O módulo puxa o engine e o servidor do companion; aqui só a regra importa.
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
    session('velha', 40),
    session('recente', 5),
    session('fixada', 40, { pinned: true }),
    session('ja-arquivada', 40, { archived: true }),
    session('rotina', 40, { routineId: 'r1' }),
    session('worker', 40, { parentId: 'pai' }),
    session('rodando', 40),
  ]

  it('só arquiva o que o usuário deixou de lado', () => {
    const stale = staleSessions(sessions, 30, now, new Set(['rodando']))
    expect(stale.map((s) => s.id)).toEqual(['velha'])
  })

  it('o prazo escolhido decide', () => {
    expect(staleSessions(sessions, 3, now, new Set()).map((s) => s.id)).toContain('recente')
  })
})
