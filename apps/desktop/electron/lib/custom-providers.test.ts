import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const credentials = vi.hoisted(() => new Map<string, string>())
const dir = path.join(os.tmpdir(), `orbit-custom-providers-${process.pid}`)

vi.mock('./storage', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  return { dataDir: () => path.join(os.tmpdir(), `orbit-custom-providers-${process.pid}`) }
})
vi.mock('./auth', () => ({
  setCredential: vi.fn(async (providerId: string, key: string) => {
    credentials.set(providerId, key)
  }),
  removeCredential: vi.fn(async (providerId: string) => {
    credentials.delete(providerId)
  }),
  listCredentialProviders: vi.fn(async () => [...credentials.keys()]),
}))

const {
  addCustomProvider,
  applyDiscoveredModels,
  inferReasoning,
  listCustomProviders,
  seedCustomProviders,
  updateCustomProvider,
} = await import('./custom-providers')

beforeEach(async () => {
  credentials.clear()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('addCustomProvider', () => {
  it('grava protocolo, modelos e guarda a chave fora do arquivo', async () => {
    const provider = await addCustomProvider({
      id: 'meu-gateway',
      name: 'Meu gateway',
      baseURL: 'https://gw.example.com/v1/',
      apiKey: 'sk-123',
      protocol: 'anthropic-messages',
      compat: { maxTokensField: 'max_completion_tokens' },
      models: [{ id: 'claude-x', contextWindow: 200_000 }],
    })

    expect(provider.id).toBe('custom:meu-gateway')
    expect(provider.api).toBe('https://gw.example.com/v1')
    expect(provider.protocol).toBe('anthropic-messages')
    expect(provider.compat).toEqual({ maxTokensField: 'max_completion_tokens' })
    expect(provider.env).toEqual(['CUSTOM_MEU_GATEWAY_KEY'])
    expect(provider.models['claude-x']).toMatchObject({
      id: 'claude-x',
      name: 'claude-x',
      reasoning: false,
      limit: { context: 200_000 },
    })
    expect(credentials.get('custom:meu-gateway')).toBe('sk-123')
  })

  it('com variável de ambiente não grava credencial', async () => {
    const provider = await addCustomProvider({
      id: 'gw',
      name: 'GW',
      baseURL: 'https://gw.example.com/v1',
      keyEnv: 'GW_TOKEN',
      models: [{ id: 'm' }],
    })
    expect(provider.env).toEqual(['GW_TOKEN'])
    expect(credentials.size).toBe(0)
  })

  it('recusa id e URL inválidos', async () => {
    await expect(
      addCustomProvider({ id: 'com espaço', name: 'X', baseURL: 'https://x.dev/v1' }),
    ).rejects.toThrow(/ID inválido/)
    await expect(
      addCustomProvider({ id: 'ok', name: 'X', baseURL: 'ftp://x.dev' }),
    ).rejects.toThrow(/http/)
  })
})

describe('listCustomProviders', () => {
  it('marca hasKey pela credencial salva', async () => {
    await addCustomProvider({
      id: 'com-chave',
      name: 'Com chave',
      baseURL: 'https://a.dev/v1',
      apiKey: 'sk',
      models: [{ id: 'm' }],
    })
    await addCustomProvider({
      id: 'sem-chave',
      name: 'Sem chave',
      baseURL: 'https://b.dev/v1',
      models: [{ id: 'm' }],
    })

    const providers = await listCustomProviders()
    expect(providers.find((p) => p.id === 'custom:com-chave')?.hasKey).toBe(true)
    expect(providers.find((p) => p.id === 'custom:sem-chave')?.hasKey).toBe(false)
  })
})

describe('updateCustomProvider', () => {
  it('substitui os modelos e limpa o compat quando o patch manda null', async () => {
    await addCustomProvider({
      id: 'gw',
      name: 'GW',
      baseURL: 'https://gw.dev/v1',
      compat: { thinkingFormat: 'deepseek' },
      models: [{ id: 'antigo' }],
    })

    const updated = await updateCustomProvider('gw', {
      models: [{ id: 'novo', reasoning: true }],
      compat: null,
    })

    expect(Object.keys(updated.models)).toEqual(['novo'])
    expect(updated.models.novo.reasoning).toBe(true)
    expect(updated.compat).toBeUndefined()
  })

  it('trocar para "sem chave" limpa o env e a credencial', async () => {
    await addCustomProvider({
      id: 'gw',
      name: 'GW',
      baseURL: 'https://gw.dev/v1',
      apiKey: 'sk',
      models: [{ id: 'm' }],
    })

    const updated = await updateCustomProvider('gw', { keyEnv: null })

    expect(updated.env).toEqual([])
    expect(credentials.has('custom:gw')).toBe(false)
  })
})

describe('applyDiscoveredModels', () => {
  it('preserva o que já se sabia e remove o modelo que saiu do servidor', async () => {
    await addCustomProvider({
      id: 'ollama',
      name: 'Ollama',
      baseURL: 'http://localhost:11434/v1',
      models: [{ id: 'llama3', contextWindow: 131_072, reasoning: true }],
    })

    const provider = await applyDiscoveredModels('ollama', [
      { id: 'llama3' },
      { id: 'qwen3:8b', contextWindow: 32_768 },
    ])

    expect(Object.keys(provider!.models)).toEqual(['llama3', 'qwen3:8b'])
    expect(provider!.models.llama3.limit?.context).toBe(131_072)
    expect(provider!.models.llama3.reasoning).toBe(true)
    expect(provider!.models['qwen3:8b'].reasoning).toBe(true)
  })

  it('provedor inexistente devolve undefined (não cria entrada)', async () => {
    await expect(applyDiscoveredModels('nao-existe', [{ id: 'm' }])).resolves.toBeUndefined()
  })
})

describe('seedCustomProviders', () => {
  it('semeia só na primeira execução', async () => {
    await seedCustomProviders()
    expect((await listCustomProviders()).map((p) => p.id).sort()).toEqual([
      'custom:lmstudio',
      'custom:ollama',
    ])

    await updateCustomProvider('ollama', { models: [{ id: 'llama3' }] })
    await seedCustomProviders()

    const providers = await listCustomProviders()
    expect(providers.find((p) => p.id === 'custom:ollama')?.models.llama3).toBeDefined()
  })
})

describe('inferReasoning', () => {
  it('reconhece modelos que pensam e não marca os que não pensam', () => {
    expect(inferReasoning('deepseek-reasoner')).toBe(true)
    expect(inferReasoning('qwen3-coder')).toBe(true)
    expect(inferReasoning('o3-mini')).toBe(true)
    expect(inferReasoning('gpt-5')).toBe(true)
    expect(inferReasoning('llama-3.3-70b')).toBe(false)
    expect(inferReasoning('deepseek-chat')).toBe(false)
  })
})
