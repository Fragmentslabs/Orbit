import type { TokenUsage } from '@shared/chat'

/** Tokens that count against a budget: what the models read and wrote, not the cache. */
export function tokensSpent(usage: TokenUsage | undefined): number {
  return (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.reasoning ?? 0)
}

/** True once an unattended plan has spent its ceiling (no ceiling = never). */
export function budgetExhausted(usage: TokenUsage | undefined, tokenBudget: number | undefined): boolean {
  return !!tokenBudget && tokensSpent(usage) >= tokenBudget
}
