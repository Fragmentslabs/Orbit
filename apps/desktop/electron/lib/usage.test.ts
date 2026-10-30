import { describe, expect, it } from 'vitest'
import type { LanguageModelUsage } from 'ai'
import { costOfUsage, rateFor, toStepUsage, toTokenUsage } from './usage'

/**
 * Cost with cache. The input comes summed by the provider (uncached + read +
 * written) and each part has its own price in models.dev. Before, the cache read
 * was charged as zero, which underestimated every turn with cache.
 */

function usage(partial: { input: number; output: number; read?: number; write?: number; reasoning?: number }): LanguageModelUsage {
  const read = partial.read ?? 0
  const write = partial.write ?? 0
  return {
    inputTokens: partial.input,
    outputTokens: partial.output,
    totalTokens: partial.input + partial.output,
    inputTokenDetails: {
      noCacheTokens: partial.input - read - write,
      cacheReadTokens: read,
      cacheWriteTokens: write,
    },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: partial.reasoning },
  } as LanguageModelUsage
}

describe('cost with cache', () => {
  const price = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }

  it('charges each part of the input at its price', () => {
    // 10k uncached, 90k read, 4k written, 2k of output
    const result = toTokenUsage(usage({ input: 104_000, output: 2_000, read: 90_000, write: 4_000 }), price)
    const expected = (10_000 * 3 + 90_000 * 0.3 + 4_000 * 3.75 + 2_000 * 15) / 1_000_000
    expect(result.cost).toBeCloseTo(expected, 10)
  })

  it('the read cache is no longer free', () => {
    const result = toTokenUsage(usage({ input: 100_000, output: 0, read: 100_000 }), price)
    expect(result.cost).toBeCloseTo((100_000 * 0.3) / 1_000_000, 10)
    expect(result.cost).toBeGreaterThan(0)
  })

  it('a model without a cache price falls back to the input price, without underestimating', () => {
    const result = toTokenUsage(usage({ input: 100_000, output: 0, read: 100_000 }), { input: 3, output: 15 })
    expect(result.cost).toBeCloseTo((100_000 * 3) / 1_000_000, 10)
  })

  it('without cache, the cost is the previous one', () => {
    const result = toTokenUsage(usage({ input: 1_000, output: 500 }), price)
    expect(result.cost).toBeCloseTo((1_000 * 3 + 500 * 15) / 1_000_000, 10)
  })
})

describe('step with cache and reasoning', () => {
  it('stores the cache and reasoning of the step, not only of the turn', () => {
    const step = toStepUsage(usage({ input: 50_000, output: 1_500, read: 40_000, write: 2_000, reasoning: 900 }))
    expect(step).toEqual({ input: 50_000, output: 1_500, cacheRead: 40_000, cacheWrite: 2_000, reasoning: 900 })
  })
})

describe('price tiers by context size', () => {
  // models.dev's format: base price + tier above 200k tokens.
  const priced = {
    input: 1.25,
    output: 10,
    cache_read: 0.31,
    cache_write: 2.375,
    tiers: [
      { input: 2.5, output: 15, cache_read: 0.25, cache_write: 4.5, tier: { type: 'context', size: 200_000 } },
    ],
  }

  it('below the limit, the base price applies', () => {
    expect(rateFor(priced, 150_000).input).toBe(1.25)
  })

  it('above the limit, the tier applies', () => {
    expect(rateFor(priced, 250_000).input).toBe(2.5)
  })

  it('at the exact limit, the base still applies (the tier starts after it)', () => {
    expect(rateFor(priced, 200_000).input).toBe(1.25)
  })

  it('ignores a tier that is not about context', () => {
    const other = { ...priced, tiers: [{ input: 9, output: 9, tier: { type: 'time', size: 1 } }] }
    expect(rateFor(other, 500_000).input).toBe(1.25)
  })

  it('the call cost uses the tier according to ITS size, not the turn size', () => {
    // One call of 250k and another of 50k: each one at its own price.
    const big = usage({ input: 250_000, output: 0 })
    const small = usage({ input: 50_000, output: 0 })
    const total = costOfUsage(big, priced) + costOfUsage(small, priced)
    expect(total).toBeCloseTo((250_000 * 2.5 + 50_000 * 1.25) / 1_000_000, 10)
    // Adding the two together as if they were a single call would give another number.
    expect(total).not.toBeCloseTo(costOfUsage(usage({ input: 300_000, output: 0 }), priced), 6)
  })

  it('the tier also has its cache price', () => {
    const cost = costOfUsage(usage({ input: 250_000, output: 0, read: 200_000 }), priced)
    // 50k uncached at 2.5, 200k read at 0.25
    expect(cost).toBeCloseTo((50_000 * 2.5 + 200_000 * 0.25) / 1_000_000, 10)
  })
})
