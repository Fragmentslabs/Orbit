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
 * O bug de origem: o OpenCode Go declara openai-compatible no provedor, mas o
 * Claude Haiku só existe pelo protocolo Anthropic, em /go/anthropic/v1. O
 * Orbit mandava tudo pelo endpoint OpenAI e o gateway respondia "Model does
 * not support this protocol.".
 */
describe('resolveModel — protocolo por modelo', () => {
  afterEach(() => vi.unstubAllGlobals())

  async function requestUrl(modelId: string): Promise<string> {
    let url = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      url = String(input instanceof Request ? input.url : input)
      return new Response('{}', { status: 500 })
    })
    const model = await resolveModel('opencode-go', modelId, { sessionId: 's1' })
    await generateText({ model, prompt: 'oi', maxRetries: 0 }).catch(() => undefined)
    return url
  }

  it('o Claude vai pelo protocolo Anthropic, no endpoint do modelo', async () => {
    expect(await requestUrl('claude-haiku-5-5')).toBe('https://opencode.ai/inference/go/anthropic/v1/messages')
  })

  it('o resto continua no endpoint openai-compatible do provedor', async () => {
    expect(await requestUrl('deepseek-v4-pro')).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions')
  })
})
