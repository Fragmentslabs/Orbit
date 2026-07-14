import fs from 'node:fs/promises'
import path from 'node:path'
import type { CatalogProvider } from '@shared/chat'
import { dataDir } from './storage'

export interface CustomProviderEntry {
  provider: CatalogProvider
  createdAt: number
}

const PROVIDERS_FILE = 'custom-providers.json'

const SEED_PROVIDERS: CatalogProvider[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    env: [],
    api: 'http://localhost:11434/v1',
    models: {},
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    env: [],
    api: 'http://localhost:1234/v1',
    models: {},
  },
]

function filePath() {
  return path.join(dataDir(), PROVIDERS_FILE)
}

async function readAll(): Promise<Record<string, CustomProviderEntry>> {
  try {
    return JSON.parse(await fs.readFile(filePath(), 'utf8'))
  } catch {
    return {}
  }
}

async function writeAll(data: Record<string, CustomProviderEntry>): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true })
  await fs.writeFile(filePath(), JSON.stringify(data, null, 2), 'utf8')
}

function toKey(id: string): string {
  return `custom:${id}`
}

export async function listCustomProviders(): Promise<CatalogProvider[]> {
  const data = await readAll()
  return Object.values(data)
    .map((e) => e.provider)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function addCustomProvider(
  id: string,
  name: string,
  baseURL: string,
  apiKey?: string,
): Promise<CatalogProvider> {
  const data = await readAll()
  const key = toKey(id)
  if (data[key]) throw new Error(`Provedor "${id}" já existe`)

  const provider: CatalogProvider = {
    id: `custom:${id}`,
    name,
    env: apiKey ? [`CUSTOM_${id.toUpperCase()}_KEY`] : [],
    api: baseURL,
    models: {},
  }

  data[key] = { provider, createdAt: Date.now() }
  await writeAll(data)

  if (apiKey) {
    const { setCredential } = await import('./auth')
    await setCredential(provider.id, apiKey)
  }

  return provider
}

export async function removeCustomProvider(id: string): Promise<void> {
  const data = await readAll()
  const key = toKey(id)
  const removed = data[key]
  delete data[key]
  await writeAll(data)

  if (removed) {
    const { removeCredential } = await import('./auth')
    await removeCredential(removed.provider.id)
  }
}

export async function updateCustomProvider(
  id: string,
  patch: { name?: string; baseURL?: string; apiKey?: string },
): Promise<CatalogProvider> {
  const data = await readAll()
  const key = toKey(id)
  const existing = data[key]
  if (!existing) throw new Error(`Provedor "${id}" não encontrado`)

  const provider = existing.provider

  if (patch.name !== undefined) provider.name = patch.name
  if (patch.baseURL !== undefined) provider.api = patch.baseURL
  if (patch.apiKey !== undefined) {
    const { setCredential } = await import('./auth')
    await setCredential(provider.id, patch.apiKey)
    if (!provider.env.length) {
      provider.env = [`CUSTOM_${id.toUpperCase()}_KEY`]
    }
  }

  data[key] = { ...existing, provider }
  await writeAll(data)

  return provider
}

export async function seedCustomProviders(): Promise<void> {
  const data = await readAll()
  let changed = false

  for (const seed of SEED_PROVIDERS) {
    const key = toKey(seed.id)
    if (!data[key]) {
      data[key] = { provider: seed, createdAt: Date.now() }
      changed = true
    }
  }

  if (changed) await writeAll(data)
}
