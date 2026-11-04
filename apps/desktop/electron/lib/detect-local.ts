import type { CatalogProvider, DiscoveredModel } from '@shared/chat'
import { resolveApiKey } from './auth'
import { applyDiscoveredModels, ensureSeedProvider, getCustomProvider } from './custom-providers'
import { discoverModels } from './discover-models'
import type { DiscoverOptions } from './discover-models'
import { tNow } from './i18n'

/**
 * Known local servers. The detection does not only answer "it is running" — it
 * ADOPTS the models found into the corresponding provider: before, the result
 * stayed only on the screen and the provider kept having no models, invisible in the selector.
 */

export interface DetectResult {
  /** Id do provedor personalizado (`custom:ollama`). */
  providerId: string
  name: string
  baseURL: string
  detected: boolean
  models: string[]
  error?: string
}

const DETECTORS = [
  { id: 'ollama', name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1' },
  { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1' },
]

export async function detectLocal(): Promise<DetectResult[]> {
  const results: DetectResult[] = []

  for (const detector of DETECTORS) {
    const providerId = `custom:${detector.id}`
    try {
      const models = await discoverModels({ baseURL: detector.baseURL })
      if (models.length > 0) {
        await ensureSeedProvider(detector.id)
        await applyDiscoveredModels(detector.id, models)
      }
      results.push({
        providerId,
        name: detector.name,
        baseURL: detector.baseURL,
        detected: true,
        models: models.map((model) => model.id),
      })
    } catch (err) {
      results.push({
        providerId,
        name: detector.name,
        baseURL: detector.baseURL,
        detected: false,
        models: [],
        error: (err as Error).message,
      })
    }
  }

  return results
}

/**
 * Updates a custom provider's models from its own
 * endpoint (the card's "fetch models" button). Used both for local servers
 * and for gateways that got new models.
 */
export async function refreshProviderModels(id: string): Promise<CatalogProvider> {
  const provider = await getCustomProvider(id)
  if (!provider) throw new Error(tNow('provider.notFound'))
  if (!provider.api) throw new Error(tNow('provider.noBaseUrl'))

  const apiKey = await resolveApiKey(provider.id, provider.env)
  const models = await discoverModels({
    baseURL: provider.api,
    apiKey,
    protocol: provider.protocol,
  })
  const updated = await applyDiscoveredModels(id, models)
  if (!updated) throw new Error(tNow('provider.notFound'))
  return updated
}

/**
 * Discovery from the edit dialog: the URL and the protocol come from what is
 * on screen, but the KEY may already be saved — without this, editing a provider and
 * asking to "fetch models" would answer 401 even with the credential written.
 */
export async function discoverProviderModels(
  providerId: string,
  opts: DiscoverOptions,
): Promise<DiscoveredModel[]> {
  const key = opts.apiKey?.trim()
  if (key) return discoverModels({ ...opts, apiKey: key })

  const provider = await getCustomProvider(providerId)
  const apiKey = await resolveApiKey(providerId, provider?.env ?? [])
  return discoverModels({ ...opts, apiKey })
}
