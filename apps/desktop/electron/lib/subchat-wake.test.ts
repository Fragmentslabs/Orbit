import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, SessionInfo } from '@shared/chat'

vi.mock('./chat-engine', () => ({ getRunningSessionIds: () => [], lastTurnAborted: () => false, runChat: vi.fn() }))
vi.mock('./storage', () => ({ readJson: async () => null }))
vi.mock('./i18n', () => ({
  tNow: (key: string, vars?: Record<string, string>) => (vars ? `${key} ${vars.title}` : key),
}))

const { wakeStreak, wakeText } = await import('./subchat-wake')

function msg(role: 'user' | 'assistant', extra: Partial<ChatMessage> = {}, text = ''): ChatMessage {
  return { id: Math.random().toString(36), role, parts: text ? [{ id: 'p', type: 'text', text, state: 'done' }] : [], createdAt: 0, ...extra } as ChatMessage
}

const child = { id: 'ses_child', title: 'Fix login' } as SessionInfo

describe('wakeStreak', () => {
  it('counts subchat wakes since the last message the user typed', () => {
    expect(wakeStreak([])).toBe(0)
    expect(wakeStreak([msg('user'), msg('assistant')])).toBe(0)
    expect(
      wakeStreak([
        msg('user', { origin: 'subchat' }),
        msg('user'),
        msg('assistant'),
        msg('user', { origin: 'subchat' }),
        msg('assistant'),
        msg('user', { origin: 'subchat' }),
        msg('assistant'),
      ]),
    ).toBe(2)
  })
})

describe('wakeText', () => {
  it('carries the subchat title and its final answer', () => {
    expect(wakeText(child, msg('assistant', {}, 'Done: fixed src/login.ts'))).toBe('subchat.finished Fix login\n\nDone: fixed src/login.ts')
  })

  it('says when the turn failed or had no text', () => {
    expect(wakeText(child, msg('assistant', { error: 'rate limit' }))).toContain('subchat.finishedError rate limit')
    expect(wakeText(child, msg('assistant'))).toContain('subchat.finishedEmpty')
    expect(wakeText(child, undefined)).toContain('subchat.finishedEmpty')
  })

  it('caps a long answer', () => {
    expect(wakeText(child, msg('assistant', {}, 'x'.repeat(10_000))).length).toBeLessThan(4_200)
  })
})
