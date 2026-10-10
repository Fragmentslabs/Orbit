import type { LanguageModelUsage } from 'ai'
import type { TokenUsage } from '@shared/chat'

/**
 * Conversão do usage aninhado do ai-sdk v7 para o TokenUsage persistido nas
 * mensagens, com custo em USD a partir dos preços do catálogo (por 1M tokens).
 */

export interface ModelCost {
  input: number
  output: number
  /** Leitura do cache, por 1M tokens (models.dev). */
  cache_read?: number
  /** Gravação no cache, por 1M tokens (models.dev). */
  cache_write?: number
  /** Preços por faixa de contexto: quando a chamada passa do tamanho, vale a faixa. */
  tiers?: ModelCostTier[]
}

export interface ModelCostTier extends Omit<ModelCost, 'tiers'> {
  tier?: { type: string; size: number }
}

/**
 * Preço que vale para uma chamada. O models.dev traz faixas por tamanho de
 * contexto (ex.: acima de 200k tokens o preço muda): quando a entrada da
 * chamada passa do tamanho de uma faixa, vale a de maior tamanho que ela
 * ultrapassa. Senão, o preço base.
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
 * Custo em USD de UMA chamada ao modelo. Cada parte da entrada é cobrada no seu
 * preço: sem cache, lida do cache e gravada no cache (o provedor soma as três
 * em `inputTokens`). Modelo sem preço de cache cai no preço de entrada, o que
 * nunca subestima o custo.
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

/** Usage de um único step (ex.: evento 'finish-step' do fullStream) — usado
 * como proxy do tamanho real do contexto atual, ao contrário do usage total
 * do turno (soma de todos os steps, inflado por idas-e-vindas de tool). */
export function toStepUsage(usage: LanguageModelUsage): NonNullable<TokenUsage['lastStep']> {
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    // Parte da entrada desta chamada que veio do cache / foi gravada nele —
    // é o que diz se o contexto atual está sendo reaproveitado entre passos.
    cacheRead: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    // Raciocínio é parte da saída deste passo (vem junto no total de output).
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
