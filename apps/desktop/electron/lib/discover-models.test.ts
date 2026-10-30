import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverModels, parseModelList } from './discover-models'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseModelList', () => {
  it('reads the OpenAI/gateway format', () => {
    expect(parseModelList({ data: [{ id: 'gpt-4o' }, { id: 'o3-mini' }] })).toEqual([
      { id: 'gpt-4o' },
      { id: 'o3-mini' },
    ])
  })

  it('reads the native Ollama format and strips the ":latest"', () => {
    const models = parseModelList({
      models: [{ name: 'llama3.2:latest', details: { context_length: 131072 } }],
    })
    expect(models).toEqual([{ id: 'llama3.2', contextWindow: 131072 }])
  })

  it('reads the Anthropic format (display_name)', () => {
    expect(parseModelList({ data: [{ id: 'claude-x', display_name: 'Claude X' }] })).toEqual([
      { id: 'claude-x', name: 'Claude X' },
    ])
  })

  it('ignores an item without id and duplicates', () => {
    expect(parseModelList({ data: [{ id: 'a' }, { id: 'a' }, { foo: 'bar' }] })).toEqual([{ id: 'a' }])
  })

  it('a response without a list returns empty', () => {
    expect(parseModelList({ error: 'nope' })).toEqual([])
    expect(parseModelList(null)).toEqual([])
  })
})

describe('discoverModels', () => {
  it('queries {base}/models and returns the models', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: 'a' }, { id: 'b' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const models = await discoverModels({ baseURL: 'https://gw.example.com/v1/' })

    expect(models.map((m) => m.id)).toEqual(['a', 'b'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://gw.example.com/v1/models')
  })

  it('falls back to the Ollama /api/tags when /v1/models does not exist', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/api/tags')
        ? jsonResponse({ models: [{ name: 'qwen3:8b' }] })
        : jsonResponse({ error: 'not found' }, 404),
    )
    vi.stubGlobal('fetch', fetchMock)

    const models = await discoverModels({ baseURL: 'http://localhost:11434/v1' })

    expect(models.map((m) => m.id)).toEqual(['qwen3:8b'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a server that answers without models returns an empty list (not an error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [] })))
    await expect(discoverModels({ baseURL: 'http://localhost:1234/v1' })).resolves.toEqual([])
  })

  it('all URLs failing throws with the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)))
    await expect(discoverModels({ baseURL: 'https://gw.example.com/v1' })).rejects.toThrow(/HTTP 401/)
  })

  it('uses bearer in the OpenAI protocol and x-api-key in Anthropic', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: 'a' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await discoverModels({ baseURL: 'https://gw.example.com/v1', apiKey: 'sk-1' })
    const openaiInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((openaiInit.headers as Record<string, string>).authorization).toBe('Bearer sk-1')

    await discoverModels({
      baseURL: 'https://gw.example.com/v1',
      apiKey: 'sk-2',
      protocol: 'anthropic-messages',
    })
    const anthropicInit = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1]
    const headers = anthropicInit.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-2')
    expect(headers.authorization).toBeUndefined()
  })
})
