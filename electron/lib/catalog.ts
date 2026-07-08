import fs from 'node:fs/promises'
import path from 'node:path'
import type { Catalog, CatalogProvider } from '../../shared/chat'
import { dataDir } from './storage'

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
    return catalog
  } catch {
    return null
  }
}

export async function getCatalog(): Promise<Catalog> {
  if (cached) return cached

  const cache = await readCache()
  if (cache) {
    cached = cache.catalog
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

export async function getProvider(providerId: string): Promise<CatalogProvider | undefined> {
  const catalog = await getCatalog()
  return catalog[providerId]
}
