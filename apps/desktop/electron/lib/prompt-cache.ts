import type { ModelMessage } from 'ai'

/**
 * Anthropic's prompt cache. Unlike OpenAI and DeepSeek, which
 * cache the prefix on their own, Anthropic only caches up to where the request marks
 * `cache_control` — with no mark at all, every step of the tool loop paid the whole prefix
 * (tools + system + history) at full price. With the mark, reading the
 * cache costs ~10% of the input.
 *
 * Three marks, out of the four the API accepts:
 * - the FIRST message: the tools + system + start-of-history prefix, which
 *   only changes when the conversation is compacted — it counts between turns;
 * - the LAST TWO: the point where the next step continues. The API looks for a
 *   cached prefix up to 20 blocks before each mark, and a step of the tool
 *   loop adds two (the call and the result), so the following step
 *   always finds the previous one.
 */

const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const

/** SDKs that speak the Anthropic Messages protocol and read the mark. */
export function supportsAnthropicCache(npm: string): boolean {
  return npm === '@ai-sdk/anthropic'
}

export function withAnthropicCache(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages
  const marks = new Set([0, messages.length - 2, messages.length - 1].filter((i) => i >= 0))
  return messages.map((message, i) => {
    if (!marks.has(i)) return message
    const options = message.providerOptions ?? {}
    return {
      ...message,
      providerOptions: {
        ...options,
        anthropic: { ...(options.anthropic ?? {}), ...ANTHROPIC_CACHE.anthropic },
      },
    } as ModelMessage
  })
}
