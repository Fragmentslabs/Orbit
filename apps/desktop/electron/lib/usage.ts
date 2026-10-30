import type { LanguageModelUsage } from 'ai'
import type { TokenUsage } from '@shared/chat'

/**
 * Conversion of the ai-sdk v7 nested usage into the TokenUsage persisted in the
 * messages, with cost in USD from the catalog's prices (per 1M tokens).
 */

export interface ModelCost {
  input: number
  output: number
  /** Cache read, per 1M tokens (models.dev). */
  cache_read?: number
  /** Cache write, per 1M tokens (models.dev). */
  cache_write?: number
  /** Prices per context tier: when the call goes past the size, the tier applies. */
  tiers?: ModelCostTier[]
}

export interface ModelCostTier extends Omit<ModelCost, 'tiers'> {
  tier?: { type: string; size: number }
}

/**
 * Price that applies to a call. models.dev brings tiers by context size
 * (e.g. above 200k tokens the price changes): when the call's input goes
 * past a tier's size, the one of the largest size it exceeds applies.
 * Otherwise, the base price.
 */
export function rateFor(cost: ModelCost, promptTokens: number): ModelCost {
  let rate: ModelCost = cost
  let best = -1
  for (const t of cost.tiers ?? []) {
    if (t.tier?.type !== 'context') continue
    if (promptTokens > t.tier.size && t.tier.size > best) {
      rate = t
      best = t.tier.size
    }
  }
  return rate
}

/**
 * Cost in USD of ONE call to the model. Each part of the input is charged at its own
 * price: uncached, read from the cache and written to the cache (the provider adds the three
 * in `inputTokens`). A model without a cache price falls back to the input price, which
 * never underestimates the cost.
 */
export function costOfUsage(usage: LanguageModelUsage, cost: ModelCost): number {
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0
  const noCache = usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, input - cacheRead - cacheWrite)
  const rate = rateFor(cost, input)
  return (
    noCache * rate.input +
    cacheRead * (rate.cache_read ?? rate.input) +
    cacheWrite * (rate.cache_write ?? rate.input) +
    output * rate.output
  ) / 1_000_000
}

/** Usage of a single step (e.g. the 'finish-step' event of fullStream) — used
 * as a proxy for the real size of the current context, unlike the turn's total
 * usage (sum of all steps, inflated by tool round-trips). */
export function toStepUsage(usage: LanguageModelUsage): NonNullable<TokenUsage['lastStep']> {
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    // Part of this call's input that came from the cache / was written to it —
    // it is what says whether the current context is being reused between steps.
    cacheRead: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    // Reasoning is part of this step's output (it comes along in the output total).
    reasoning: usage.outputTokenDetails?.reasoningTokens ?? 0,
  }
}

export function toTokenUsage(usage: LanguageModelUsage, cost?: ModelCost): TokenUsage {
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const result: TokenUsage = {
    input,
    output,
    reasoning: usage.outputTokenDetails?.reasoningTokens ?? 0,
    cacheRead: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  }
  if (cost) result.cost = costOfUsage(usage, cost)
  return result
}

export function addTokenUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage {
  return {
    input: (a?.input ?? 0) + (b?.input ?? 0),
    output: (a?.output ?? 0) + (b?.output ?? 0),
    reasoning: (a?.reasoning ?? 0) + (b?.reasoning ?? 0),
    cacheRead: (a?.cacheRead ?? 0) + (b?.cacheRead ?? 0),
    cacheWrite: (a?.cacheWrite ?? 0) + (b?.cacheWrite ?? 0),
    cost:
      a?.cost !== undefined || b?.cost !== undefined
        ? (a?.cost ?? 0) + (b?.cost ?? 0)
        : undefined,
  }
}
