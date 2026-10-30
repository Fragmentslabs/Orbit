import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateText } from 'ai'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }))
vi.mock('./auth', () => ({ resolveApiKey: async () => 'test-key' }))
vi.mock('./catalog', () => ({
  getProvider: async (id: string) =>
    id === 'opencode-go'
      ? {
          id: 'opencode-go',
          name: 'OpenCode Go',
          npm: '@ai-sdk/openai-compatible',
          api: 'https://opencode.ai/inference/go/openai/v1',
          env: ['OPENCODE_API_KEY'],
          models: {
            'claude-haiku-5-5': {
              id: 'claude-haiku-5-5',
              name: 'Claude Haiku 5.5',
              provider: { npm: '@ai-sdk/anthropic', api: 'https://opencode.ai/inference/go/anthropic/v1' },
            },
            'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
          },
        }
      : undefined,
}))

import { resolveModel } from './providers'

/**
 * The original bug: OpenCode Go declares openai-compatible in the provider, but
 * Claude Haiku only exists through the Anthropic protocol, at /go/anthropic/v1. Orbit
 * sent everything through the OpenAI endpoint and the gateway answered "Model does
 * not support this protocol.".
 */
describe('resolveModel — protocol per model', () => {
  afterEach(() => vi.unstubAllGlobals())

  async function requestUrl(modelId: string): Promise<string> {
    let url = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      url = String(input instanceof Request ? input.url : input)
      return new Response('{}', { status: 500 })
    })
    const model = await resolveModel('opencode-go', modelId, { sessionId: 's1' })
    await generateText({ model, prompt: 'hi', maxRetries: 0 }).catch(() => undefined)
    return url
  }

  it('Claude goes through the Anthropic protocol, at the model endpoint', async () => {
    expect(await requestUrl('claude-haiku-5-5')).toBe('https://opencode.ai/inference/go/anthropic/v1/messages')
  })

  it('the rest stays on the provider openai-compatible endpoint', async () => {
    expect(await requestUrl('deepseek-v4-pro')).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions')
  })
})
