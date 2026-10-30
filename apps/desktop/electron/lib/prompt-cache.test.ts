import { describe, expect, it } from 'vitest'
import { createAnthropic } from '@ai-sdk/anthropic'
import { generateText, type ModelMessage } from 'ai'

import { supportsAnthropicCache, withAnthropicCache } from './prompt-cache'
import { modelRuntime } from './provider-npm'

const history: ModelMessage[] = [
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'answer' },
  { role: 'user', content: 'second' },
  { role: 'assistant', content: 'another' },
  { role: 'user', content: 'last' },
]

const marked = (messages: ModelMessage[]) =>
  messages.flatMap((m, i) => (m.providerOptions?.anthropic?.cacheControl ? [i] : []))

describe('withAnthropicCache', () => {
  it('marks the first and the last two messages', () => {
    expect(marked(withAnthropicCache(history))).toEqual([0, 3, 4])
  })

  it('never goes past three marks, not even with a short history', () => {
    expect(marked(withAnthropicCache(history.slice(0, 1)))).toEqual([0])
    expect(marked(withAnthropicCache(history.slice(0, 2)))).toEqual([0, 1])
  })

  it('preserves the providerOptions the message already had', () => {
    const [first] = withAnthropicCache([
      { role: 'user', content: 'x', providerOptions: { anthropic: { foo: 1 }, openaiCompatible: { bar: 2 } } },
    ])
    expect(first.providerOptions).toEqual({
      anthropic: { foo: 1, cacheControl: { type: 'ephemeral' } },
      openaiCompatible: { bar: 2 },
    })
  })

  it('reaches the request body as cache_control', async () => {
    // The mark only counts if the SDK translates it: without this, a rename in the SDK would make the
    // cache vanish silently, with no error at all.
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
    // Anthropic joins consecutive messages of the same role; here there are none, so
    // they are the same five: the first and the last two marked.
    expect(cached).toEqual([true, false, false, true, true])
  })
})

describe('modelRuntime', () => {
  // The real case: in OpenCode Go the provider declares openai-compatible, but
  // Claude Haiku only exists through the Anthropic protocol, at another endpoint. Through the
  // OpenAI endpoint the gateway answers "Model does not support this protocol.".
  const opencodeGo = { npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/inference/go/openai/v1' }

  it('uses the package and the model endpoint when the catalog declares them', () => {
    const haiku = { provider: { npm: '@ai-sdk/anthropic', api: 'https://opencode.ai/inference/go/anthropic/v1' } }
    expect(modelRuntime(opencodeGo, haiku)).toEqual({
      npm: '@ai-sdk/anthropic',
      api: 'https://opencode.ai/inference/go/anthropic/v1',
    })
    expect(supportsAnthropicCache(modelRuntime(opencodeGo, haiku).npm)).toBe(true)
  })

  it('falls back to the provider one without an override', () => {
    expect(modelRuntime(opencodeGo, {})).toEqual(opencodeGo)
    expect(modelRuntime(opencodeGo, { provider: { api: 'https://x/v1' } })).toEqual({
      npm: '@ai-sdk/openai-compatible',
      api: 'https://x/v1',
    })
  })

  it('in a custom provider, the protocol of the registration decides', () => {
    expect(modelRuntime({ protocol: 'anthropic-messages', api: 'https://gw/v1' }).npm).toBe('@ai-sdk/anthropic')
  })
})
