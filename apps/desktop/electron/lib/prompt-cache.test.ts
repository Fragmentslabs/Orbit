import { describe, expect, it } from 'vitest'
import { createAnthropic } from '@ai-sdk/anthropic'
import { generateText, type ModelMessage } from 'ai'

import { supportsAnthropicCache, withAnthropicCache } from './prompt-cache'
import { modelRuntime } from './provider-npm'

const history: ModelMessage[] = [
  { role: 'user', content: 'primeira' },
  { role: 'assistant', content: 'resposta' },
  { role: 'user', content: 'segunda' },
  { role: 'assistant', content: 'outra' },
  { role: 'user', content: 'última' },
]

const marked = (messages: ModelMessage[]) =>
  messages.flatMap((m, i) => (m.providerOptions?.anthropic?.cacheControl ? [i] : []))

describe('withAnthropicCache', () => {
  it('marca a primeira e as duas últimas mensagens', () => {
    expect(marked(withAnthropicCache(history))).toEqual([0, 3, 4])
  })

  it('nunca passa de três marcas, nem com histórico curto', () => {
    expect(marked(withAnthropicCache(history.slice(0, 1)))).toEqual([0])
    expect(marked(withAnthropicCache(history.slice(0, 2)))).toEqual([0, 1])
  })

  it('preserva o providerOptions que a mensagem já tinha', () => {
    const [first] = withAnthropicCache([
      { role: 'user', content: 'x', providerOptions: { anthropic: { foo: 1 }, openaiCompatible: { bar: 2 } } },
    ])
    expect(first.providerOptions).toEqual({
      anthropic: { foo: 1, cacheControl: { type: 'ephemeral' } },
      openaiCompatible: { bar: 2 },
    })
  })

  it('chega ao corpo do request como cache_control', async () => {
    // A marca só vale se o SDK a traduzir: sem isto, um rename no SDK faria o
    // cache sumir em silêncio, sem erro nenhum.
    let body: { messages: Array<{ content: Array<{ cache_control?: unknown }> }> } | undefined
    const anthropic = createAnthropic({
      apiKey: 'test',
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          JSON.stringify({
            id: 'msg', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
            content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })
    await generateText({ model: anthropic('claude-haiku-4-5'), messages: withAnthropicCache(history) })
    const cached = body!.messages.map((m) => m.content.some((c) => c.cache_control != null))
    // A Anthropic junta mensagens seguidas do mesmo papel; aqui não há, então
    // são as mesmas cinco: a primeira e as duas últimas marcadas.
    expect(cached).toEqual([true, false, false, true, true])
  })
})

describe('modelRuntime', () => {
  // O caso real: no OpenCode Go o provedor declara openai-compatible, mas o
  // Claude Haiku só existe pelo protocolo Anthropic, em outro endpoint. Pelo
  // endpoint OpenAI o gateway responde "Model does not support this protocol.".
  const opencodeGo = { npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/inference/go/openai/v1' }

  it('usa o pacote e o endpoint do modelo quando o catálogo os declara', () => {
    const haiku = { provider: { npm: '@ai-sdk/anthropic', api: 'https://opencode.ai/inference/go/anthropic/v1' } }
    expect(modelRuntime(opencodeGo, haiku)).toEqual({
      npm: '@ai-sdk/anthropic',
      api: 'https://opencode.ai/inference/go/anthropic/v1',
    })
    expect(supportsAnthropicCache(modelRuntime(opencodeGo, haiku).npm)).toBe(true)
  })

  it('cai no do provedor sem override', () => {
    expect(modelRuntime(opencodeGo, {})).toEqual(opencodeGo)
    expect(modelRuntime(opencodeGo, { provider: { api: 'https://x/v1' } })).toEqual({
      npm: '@ai-sdk/openai-compatible',
      api: 'https://x/v1',
    })
  })

  it('no provedor personalizado, o protocolo do cadastro decide', () => {
    expect(modelRuntime({ protocol: 'anthropic-messages', api: 'https://gw/v1' }).npm).toBe('@ai-sdk/anthropic')
  })
})
