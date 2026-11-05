import { describe, expect, it } from 'vitest'
import { ROUTINE_CHAT_SUMMARY_LIMIT, routineChatIsFull } from '@shared/routines'
import { COMPACT_SUGGEST_AFTER } from '@shared/app-settings'

describe('routineChatIsFull', () => {
  it('offers a new chat from the same compaction count as the compaction card', () => {
    expect(ROUTINE_CHAT_SUMMARY_LIMIT).toBe(COMPACT_SUGGEST_AFTER)
  })

  it('stays quiet below the limit and offers from the limit on', () => {
    expect(routineChatIsFull(0)).toBe(false)
    expect(routineChatIsFull(ROUTINE_CHAT_SUMMARY_LIMIT - 1)).toBe(false)
    expect(routineChatIsFull(ROUTINE_CHAT_SUMMARY_LIMIT)).toBe(true)
    expect(routineChatIsFull(ROUTINE_CHAT_SUMMARY_LIMIT + 5)).toBe(true)
  })
})
