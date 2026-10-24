import type { ModelMessage } from 'ai'

/**
 * Cache de prompt da Anthropic. Ao contrário do OpenAI e do DeepSeek, que
 * cacheiam o prefixo sozinhos, a Anthropic só cacheia até onde o request marca
 * `cache_control` — sem marca nenhuma, todo passo do tool loop pagava o prefixo
 * inteiro (tools + system + histórico) a preço cheio. Com a marca, a leitura
 * do cache custa ~10% do input.
 *
 * Três marcas, do limite de quatro que a API aceita:
 * - a PRIMEIRA mensagem: o prefixo tools + system + começo do histórico, que
 *   só muda quando a conversa é compactada — vale entre turnos;
 * - as DUAS ÚLTIMAS: o ponto onde o próximo passo continua. A API procura um
 *   prefixo cacheado até 20 blocos antes de cada marca, e um passo do tool
 *   loop acrescenta dois (a chamada e o resultado), então o passo seguinte
 *   sempre acha o anterior.
 */

const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const

/** SDKs que falam o protocolo Anthropic Messages e leem a marca. */
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
