import { describe, expect, it } from 'vitest'
import type { LanguageModelUsage } from 'ai'
import { costOfUsage, rateFor, toStepUsage, toTokenUsage } from './usage'

/**
 * Custo com cache. A entrada vem somada pelo provedor (sem cache + lido +
 * gravado) e cada parte tem preço próprio no models.dev. Antes o cache lido
 * era cobrado como zero, o que subestimava todo turno com cache.
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

describe('custo com cache', () => {
  const price = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }

  it('cobra cada parte da entrada no seu preço', () => {
    // 10k sem cache, 90k lidos, 4k gravados, 2k de saída
    const result = toTokenUsage(usage({ input: 104_000, output: 2_000, read: 90_000, write: 4_000 }), price)
    const expected = (10_000 * 3 + 90_000 * 0.3 + 4_000 * 3.75 + 2_000 * 15) / 1_000_000
    expect(result.cost).toBeCloseTo(expected, 10)
  })

  it('o cache lido não é mais de graça', () => {
    const result = toTokenUsage(usage({ input: 100_000, output: 0, read: 100_000 }), price)
    expect(result.cost).toBeCloseTo((100_000 * 0.3) / 1_000_000, 10)
    expect(result.cost).toBeGreaterThan(0)
  })

  it('modelo sem preço de cache cai no preço de entrada, sem subestimar', () => {
    const result = toTokenUsage(usage({ input: 100_000, output: 0, read: 100_000 }), { input: 3, output: 15 })
    expect(result.cost).toBeCloseTo((100_000 * 3) / 1_000_000, 10)
  })

  it('sem cache, o custo é o de antes', () => {
    const result = toTokenUsage(usage({ input: 1_000, output: 500 }), price)
    expect(result.cost).toBeCloseTo((1_000 * 3 + 500 * 15) / 1_000_000, 10)
  })
})

describe('passo com cache e raciocínio', () => {
  it('guarda cache e raciocínio do passo, não só do turno', () => {
    const step = toStepUsage(usage({ input: 50_000, output: 1_500, read: 40_000, write: 2_000, reasoning: 900 }))
    expect(step).toEqual({ input: 50_000, output: 1_500, cacheRead: 40_000, cacheWrite: 2_000, reasoning: 900 })
  })
})

describe('faixas de preço por tamanho de contexto', () => {
  // Formato do models.dev: preço base + faixa acima de 200k tokens.
  const priced = {
    input: 1.25,
    output: 10,
    cache_read: 0.31,
    cache_write: 2.375,
    tiers: [
      { input: 2.5, output: 15, cache_read: 0.25, cache_write: 4.5, tier: { type: 'context', size: 200_000 } },
    ],
  }

  it('abaixo do limite, vale o preço base', () => {
    expect(rateFor(priced, 150_000).input).toBe(1.25)
  })

  it('acima do limite, vale a faixa', () => {
    expect(rateFor(priced, 250_000).input).toBe(2.5)
  })

  it('no limite exato, ainda vale o base (a faixa começa depois dele)', () => {
    expect(rateFor(priced, 200_000).input).toBe(1.25)
  })

  it('ignora faixa que não é de contexto', () => {
    const other = { ...priced, tiers: [{ input: 9, output: 9, tier: { type: 'time', size: 1 } }] }
    expect(rateFor(other, 500_000).input).toBe(1.25)
  })

  it('o custo da chamada usa a faixa conforme o tamanho DELA, não do turno', () => {
    // Uma chamada de 250k e outra de 50k: cada uma no seu preço.
    const big = usage({ input: 250_000, output: 0 })
    const small = usage({ input: 50_000, output: 0 })
    const total = costOfUsage(big, priced) + costOfUsage(small, priced)
    expect(total).toBeCloseTo((250_000 * 2.5 + 50_000 * 1.25) / 1_000_000, 10)
    // Somar os dois como se fossem uma chamada só daria outro número.
    expect(total).not.toBeCloseTo(costOfUsage(usage({ input: 300_000, output: 0 }), priced), 6)
  })

  it('a faixa também tem seu preço de cache', () => {
    const cost = costOfUsage(usage({ input: 250_000, output: 0, read: 200_000 }), priced)
    // 50k sem cache a 2.5, 200k lidos a 0.25
    expect(cost).toBeCloseTo((50_000 * 2.5 + 200_000 * 0.25) / 1_000_000, 10)
  })
})
