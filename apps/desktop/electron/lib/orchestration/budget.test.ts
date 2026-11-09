import { describe, expect, it } from 'vitest'
import { budgetExhausted, tokensSpent } from './budget'

const usage = { input: 600, output: 300, reasoning: 100, cacheRead: 5000, cacheWrite: 0 }

describe('budgetExhausted', () => {
  it('counts input, output and reasoning, not the cache', () => {
    expect(tokensSpent(usage)).toBe(1000)
  })
  it('is never exhausted without a ceiling', () => {
    expect(budgetExhausted(usage, undefined)).toBe(false)
  })
  it('is exhausted exactly at the ceiling', () => {
    expect(budgetExhausted(usage, 1000)).toBe(true)
    expect(budgetExhausted(usage, 1001)).toBe(false)
  })
  it('has spent nothing before the first turn', () => {
    expect(budgetExhausted(undefined, 10)).toBe(false)
  })
})
