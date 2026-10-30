import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Catalog } from '@shared/chat'

/**
 * The speech route through the MODEL is the non-local half of the audio priority: it
 * does not depend on weights on disk, but it does depend on a configured provider with a
 * model that knows how to speak. What is closed here is the DECISION (who is
 * configured, who knows how to speak) and the chunk contract — PCM16 24 kHz, the
 * same as the local engine, so the renderer does not need to know where it came from.
 *
 * Nothing here touches the cloud: `fetch` is a stub and the catalog is a fixed snapshot.
 */

const estado = vi.hoisted(() => ({
  catalog: {} as unknown,
  configured: [] as string[],
}))

vi.mock('./manifest', () => ({ TTS_SAMPLE_RATE: 24000 }))
vi.mock('../catalog', () => ({ getMergedCatalog: async () => estado.catalog }))
vi.mock('../auth', () => ({
  listCredentialProviders: async () => estado.configured,
  resolveApiKey: async () => 'sk-test',
}))

const { mapSpeechVoice, modelTtsStatus, pickSpeechRoute, speakWithModel } = await import('./model-tts')

function catalogOf(providerId: string, provider: Record<string, unknown>): Catalog {
  return { [providerId]: provider } as unknown as Catalog
}

const OPENAI = {
  id: 'openai',
  name: 'OpenAI',
  env: ['OPENAI_API_KEY'],
  api: 'https://api.openai.com/v1',
  models: {},
}

beforeEach(() => {
  estado.catalog = {}
  estado.configured = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pickSpeechRoute', () => {
  it('with no provider in the catalog there is no route', () => {
    expect(pickSpeechRoute({}, new Set())).toBeNull()
  })

  it('a provider with no configured key does not count', () => {
    const catalog = catalogOf('openai', {
      ...OPENAI,
      models: { 'gpt-4o': { id: 'gpt-4o', modalities: { input: ['text'], output: ['text'] } } },
    })
    expect(pickSpeechRoute(catalog, new Set(), {})).toBeNull()
  })

  it('a provider with a key and an audio-output model becomes the route', () => {
    const catalog = catalogOf('acme', {
      id: 'acme',
      name: 'Acme',
      env: [],
      api: 'https://acme.test/v1',
      models: { 'acme-tts-1': { id: 'acme-tts-1', modalities: { input: ['text'], output: ['audio'] } } },
    })
    expect(pickSpeechRoute(catalog, new Set(['acme']), {})).toMatchObject({
      providerId: 'acme',
      modelId: 'acme-tts-1',
      api: 'https://acme.test/v1',
    })
  })

  it('a key from an environment variable also configures the provider', () => {
    const catalog = catalogOf('openai', OPENAI)
    // With no speech model in the catalog, the provider's known one applies.
    expect(pickSpeechRoute(catalog, new Set(), { OPENAI_API_KEY: 'sk-test' })).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-4o-mini-tts',
    })
  })

  it('a provider with no base URL does not serve: there is nowhere to call', () => {
    const catalog = catalogOf('local', { id: 'local', name: 'Local', env: [], models: {} })
    expect(pickSpeechRoute(catalog, new Set(['local']), {})).toBeNull()
  })
})

describe('mapSpeechVoice', () => {
  it('translates the F#/M# voices to the API ones when the provider is OpenAI', () => {
    expect(mapSpeechVoice('F2', 'openai')).toBe('shimmer')
    expect(mapSpeechVoice('M1', 'openai')).toBe('onyx')
  })

  it('an unknown provider gets the original id (the failure falls back to the local engine)', () => {
    expect(mapSpeechVoice('F4', 'acme')).toBe('F4')
  })

  it('an invalid voice falls back to a default voice instead of breaking the call', () => {
    expect(mapSpeechVoice(undefined, 'openai')).toBe('nova')
    expect(mapSpeechVoice('zz', 'openai')).toBe('nova')
  })
})

describe('modelTtsStatus', () => {
  it('with no catalog/provider, unavailable with a reason', async () => {
    const status = await modelTtsStatus()
    expect(status.available).toBe(false)
    expect(status.reason?.length).toBeGreaterThan(0)
  })

  it('with a configured provider and speech model, available with the target', async () => {
    estado.catalog = catalogOf('openai', OPENAI)
    estado.configured = ['openai']
    expect(await modelTtsStatus()).toEqual({ available: true, providerId: 'openai', modelId: 'gpt-4o-mini-tts' })
  })
})

describe('speakWithModel', () => {
  it('delivers the PCM in chunks under the engine contract (24 kHz)', async () => {
    estado.catalog = catalogOf('openai', OPENAI)
    estado.configured = ['openai']
    const pcm = Buffer.alloc(8192 * 2 + 100) // two full chunks + a remainder
    const calls: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(pcm, { status: 200 })
    })

    const chunks: { i: number; n: number; sr: number; pcm: Buffer }[] = []
    const result = await speakWithModel('olá', { voice: 'F2' }, (chunk) => chunks.push(chunk))

    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/speech')
    expect(calls[0].body).toMatchObject({ model: 'gpt-4o-mini-tts', input: 'olá', response_format: 'pcm' })
    expect(chunks).toHaveLength(3)
    expect(chunks.every((chunk) => chunk.sr === 24000 && chunk.n === 3)).toBe(true)
    expect(result.pieces).toBe(3)
    expect(result.audioMs).toBeGreaterThan(0)
  })

  it('an unhappy provider response becomes an error (the pipeline falls back to local)', async () => {
    estado.catalog = catalogOf('openai', OPENAI)
    estado.configured = ['openai']
    vi.stubGlobal('fetch', async () => new Response('modelo desconhecido', { status: 404 }))

    await expect(speakWithModel('olá', {}, () => {})).rejects.toThrow(/404/)
  })

  it('with no speech provider, it does not even reach the network', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    await expect(speakWithModel('olá', {}, () => {})).rejects.toThrow(/provider/)
    expect(fetchStub).not.toHaveBeenCalled()
  })
})
