import fs from 'node:fs/promises'
import path from 'node:path'
import type { Catalog, CatalogProvider } from '@shared/chat'
import { modelSupportsVision } from '@shared/chat'
import { generateVariants, isAlwaysOnModel, toModelInput, variantLabel } from './reasoning/variants'
import { dataDir } from './storage'
import { listCustomProviders, seedCustomProviders } from './custom-providers'
import { modelRuntime } from './provider-npm'

/**
 * Catalog of providers/models from models.dev — the same source used
 * by opencode. The result is cached on disk and updated in the background.
 */

const MODELS_DEV_URL = 'https://models.dev/api.json'
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000 /**
  * Catalog of providers/models from models.dev — the same source used
  * by opencode. The result is cached on disk and updated in the background.
  */

let cached: Catalog | null = null

/**
 * Whoever wants to know that the catalog changed in the background. The interface loads the
 * catalog once when it opens; without that notice it kept showing models and
 * levels from the old catalog while the engine already used the new one. Registration by
 * callback (and not BrowserWindow here) so the module does not depend on electron.
 */
const refreshListeners = new Set<() => void>()
export function onCatalogRefreshed(listener: () => void): () => void {
  refreshListeners.add(listener)
  return () => refreshListeners.delete(listener)
}

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
 * Enriches each model with reasoning metadata (available variants and the
 * "always thinks" flag) so the renderer can assemble the UI without knowing payloads.
 */
function enrichProvider(providerId: string, provider: CatalogProvider): CatalogProvider {
  for (const modelId in provider.models) {
    const model = provider.models[modelId]
    if (!model.reasoning) continue
    // The effective npm (not just the catalog's) keeps the UI aligned with the SDK that
    // resolveModel is actually going to use — including in custom providers,
    // whose protocol chooses the SDK.
    const runtime = modelRuntime(provider, model)
    const input = toModelInput(providerId, runtime.npm, model, runtime.api)
    model.reasoningAlwaysOn = isAlwaysOnModel(input.modelId, input.apiId) || undefined
    model.variants = Object.keys(generateVariants(input)).map((id) => ({
      id,
      label: variantLabel(id),
    }))
  }
  return provider
}

function enrichCatalog(catalog: Catalog): Catalog {
  for (const providerId in catalog) enrichProvider(providerId, catalog[providerId])
  return catalog
}

/**
 * Removes models marked as `deprecated` in models.dev: they left the
 * provider's backend (the gateway answers 400 "Model is unavailable") but
 * stay in the catalog's snapshot. Same policy as the opencode client,
 * which hides those models from the selector.
 */
function pruneDeprecated(catalog: Catalog): Catalog {
  for (const providerId in catalog) {
    const provider = catalog[providerId]
    for (const modelId in provider.models) {
      if (provider.models[modelId].status === 'deprecated') {
        delete provider.models[modelId]
      }
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
    pruneDeprecated(catalog)
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
    pruneDeprecated(cache.catalog)
    cached = enrichCatalog(cache.catalog)
    if (Date.now() - cache.fetchedAt > REFRESH_INTERVAL) {
      void fetchCatalog().then((fresh) => {
        if (!fresh) return
        cached = fresh
        for (const listener of refreshListeners) listener()
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
  if (custom.length === 0) return catalog

  // A copy, not a write to the cache: `cached` is the whole module. Writing the
  // custom ones into it made a removed provider stay in the catalog until
  // the app restarted, and erased the distinction between catalog and local registration.
  const merged: Catalog = { ...catalog }
  for (const provider of custom) merged[provider.id] = enrichProvider(provider.id, provider)
  return merged
}

export async function getProvider(providerId: string): Promise<CatalogProvider | undefined> {
  const catalog = await getMergedCatalog()
  return catalog[providerId]
}

/**
 * Does the model accept images as input? It uses models.dev's modalities
 * (input includes 'image'); without modalities, it falls back to the `attachment` flag. It controls
 * whether the `see` flag of panel_screenshot is offered to the model.
 */
export { modelSupportsVision }

export async function ensureCustomProvidersSeeded(): Promise<void> {
  await seedCustomProviders()
}
