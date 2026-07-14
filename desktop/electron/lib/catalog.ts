import fs from 'node:fs/promises'
import path from 'node:path'
import type { Catalog, CatalogProvider } from '../../shared/chat'
import { generateVariants, isAlwaysOnModel, toModelInput, variantLabel } from './reasoning/variants'
import { dataDir } from './storage'
import { listCustomProviders, seedCustomProviders } from './custom-providers'

/**
 * Catálogo de provedores/modelos vindo do models.dev — a mesma fonte usada
 * pelo opencode. O resultado é cacheado em disco e atualizado em background.
 */

const MODELS_DEV_URL = 'https://models.dev/api.json'
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000 // 24h

let cached: Catalog | null = null

function cacheFile() {
  return path.join(dataDir(), 'models-dev.json')
}

async function readCache(): Promise<{ catalog: Catalog; fetchedAt: number } | null> {
  try {
    return JSON.parse(await fs.readFile(cacheFile(), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Enriquece cada modelo com metadados de reasoning (variants disponíveis e
 * flag de "sempre pensa") para o renderer montar a UI sem conhecer payloads.
 */
function enrichCatalog(catalog: Catalog): Catalog {
  for (const providerId in catalog) {
    const provider = catalog[providerId]
    for (const modelId in provider.models) {
      const model = provider.models[modelId]
      if (!model.reasoning) continue
      const input = toModelInput(providerId, provider.npm, model)
      model.reasoningAlwaysOn = isAlwaysOnModel(input.modelId, input.apiId) || undefined
      model.variants = Object.keys(generateVariants(input)).map((id) => ({
        id,
        label: variantLabel(id),
      }))
    }
  }
  return catalog
}

async function fetchCatalog(): Promise<Catalog | null> {
  try {
    const res = await fetch(MODELS_DEV_URL, {
      headers: { 'User-Agent': 'orbit-desktop' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    const catalog = (await res.json()) as Catalog
    await fs.mkdir(dataDir(), { recursive: true })
    await fs.writeFile(cacheFile(), JSON.stringify({ catalog, fetchedAt: Date.now() }), 'utf8')
    return enrichCatalog(catalog)
  } catch {
    return null
  }
}

export async function getCatalog(): Promise<Catalog> {
  if (cached) return cached

  const cache = await readCache()
  if (cache) {
    cached = enrichCatalog(cache.catalog)
    if (Date.now() - cache.fetchedAt > REFRESH_INTERVAL) {
      void fetchCatalog().then((fresh) => {
        if (fresh) cached = fresh
      })
    }
    return cached
  }

  const fresh = await fetchCatalog()
  if (fresh) {
    cached = fresh
    return fresh
  }
  return {}
}

export async function getMergedCatalog(): Promise<Catalog> {
  const catalog = await getCatalog()
  const custom = await listCustomProviders()
  for (const provider of custom) {
    catalog[provider.id] = provider
  }
  return catalog
}

export async function getProvider(providerId: string): Promise<CatalogProvider | undefined> {
  const catalog = await getMergedCatalog()
  return catalog[providerId]
}

export async function ensureCustomProvidersSeeded(): Promise<void> {
  await seedCustomProviders()
}
