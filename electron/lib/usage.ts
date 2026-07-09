import type { LanguageModelUsage } from 'ai'
import type { TokenUsage } from '../../shared/chat'

/**
 * Conversão do usage aninhado do ai-sdk v7 para o TokenUsage persistido nas
 * mensagens, com custo em USD a partir dos preços do catálogo (por 1M tokens).
 */

export interface ModelCost {
  input: number
  output: number
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
  if (cost) {
    // Aproximação: tokens lidos do cache cobrados como input normal seriam
    // superestimados — descontamos do input (o catálogo não expõe preço de cache)
    const billedInput = Math.max(0, input - result.cacheRead)
    result.cost = (billedInput * cost.input + output * cost.output) / 1_000_000
  }
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
