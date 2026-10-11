import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Catalog } from '@shared/chat'

/**
 * A rota de fala pelo MODELO é a metade não-local da prioridade de áudio: ela
 * não depende de pesos no disco, mas depende de um provedor configurado com um
 * modelo que saiba falar. O que se fecha aqui é a DECISÃO (quem está
 * configurado, quem sabe falar) e o contrato dos pedaços — PCM16 24 kHz, o
 * mesmo do motor local, para o renderer não precisar saber de onde veio.
 *
 * Nada aqui toca a nuvem: o `fetch` é um dublê e o catálogo, um retrato fixo.
 */

const estado = vi.hoisted(() => ({
  catalog: {} as unknown,
  configured: [] as string[],
}))

vi.mock('./manifest', () => ({ TTS_SAMPLE_RATE: 24000 }))
vi.mock('../catalog', () => ({ getMergedCatalog: async () => estado.catalog }))
vi.mock('../auth', () => ({
  listCredentialProviders: async () => estado.configured,
  resolveApiKey: async () => 'sk-teste',
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
  it('sem provedor no catálogo, não há rota', () => {
    expect(pickSpeechRoute({}, new Set())).toBeNull()
  })

  it('provedor sem chave configurada não conta', () => {
    const catalog = catalogOf('openai', {
      ...OPENAI,
      models: { 'gpt-4o': { id: 'gpt-4o', modalities: { input: ['text'], output: ['text'] } } },
    })
    expect(pickSpeechRoute(catalog, new Set(), {})).toBeNull()
  })

  it('provedor com chave e modelo de saída de áudio vira a rota', () => {
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

  it('chave por variável de ambiente também configura o provedor', () => {
    const catalog = catalogOf('openai', OPENAI)
    // Sem modelo de fala no catálogo, vale o conhecido do provedor.
    expect(pickSpeechRoute(catalog, new Set(), { OPENAI_API_KEY: 'sk-teste' })).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-4o-mini-tts',
    })
  })

  it('provedor sem URL base não serve: não há onde chamar', () => {
    const catalog = catalogOf('local', { id: 'local', name: 'Local', env: [], models: {} })
    expect(pickSpeechRoute(catalog, new Set(['local']), {})).toBeNull()
  })
})

describe('mapSpeechVoice', () => {
  it('traduz as vozes F#/M# para as da API quando o provedor é a OpenAI', () => {
    expect(mapSpeechVoice('F2', 'openai')).toBe('shimmer')
    expect(mapSpeechVoice('M1', 'openai')).toBe('onyx')
  })

  it('provedor desconhecido recebe o id original (a falha cai no motor local)', () => {
    expect(mapSpeechVoice('F4', 'acme')).toBe('F4')
  })

  it('voz inválida cai numa voz padrão em vez de derrubar a chamada', () => {
    expect(mapSpeechVoice(undefined, 'openai')).toBe('nova')
    expect(mapSpeechVoice('zz', 'openai')).toBe('nova')
  })
})

describe('modelTtsStatus', () => {
  it('sem catálogo/provedor, indisponível com motivo', async () => {
    const status = await modelTtsStatus()
    expect(status.available).toBe(false)
    expect(status.reason?.length).toBeGreaterThan(0)
  })

  it('com provedor configurado e modelo de fala, disponível com o alvo', async () => {
    estado.catalog = catalogOf('openai', OPENAI)
    estado.configured = ['openai']
    expect(await modelTtsStatus()).toEqual({ available: true, providerId: 'openai', modelId: 'gpt-4o-mini-tts' })
  })
})

describe('speakWithModel', () => {
  it('entrega o PCM em pedaços no contrato do motor (24 kHz)', async () => {
    estado.catalog = catalogOf('openai', OPENAI)
    estado.configured = ['openai']
    const pcm = Buffer.alloc(8192 * 2 + 100) // dois pedaços cheios + uma sobra
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

  it('resposta infeliz do provedor vira erro (o pipeline cai no local)', async () => {
    estado.catalog = catalogOf('openai', OPENAI)
    estado.configured = ['openai']
    vi.stubGlobal('fetch', async () => new Response('modelo desconhecido', { status: 404 }))

    await expect(speakWithModel('olá', {}, () => {})).rejects.toThrow(/404/)
  })

  it('sem provedor de fala, nem chega a chamar a rede', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    await expect(speakWithModel('olá', {}, () => {})).rejects.toThrow(/provedor/)
    expect(fetchStub).not.toHaveBeenCalled()
  })
})
