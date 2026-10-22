import type { CatalogProvider, DiscoveredModel } from '@shared/chat'
import { resolveApiKey } from './auth'
import { applyDiscoveredModels, ensureSeedProvider, getCustomProvider } from './custom-providers'
import { discoverModels } from './discover-models'
import type { DiscoverOptions } from './discover-models'

/**
 * Servidores locais conhecidos. A detecção não só responde "está rodando" como
 * ADOTA os modelos encontrados no provedor correspondente — antes o resultado
 * ficava só na tela e o provedor continuava sem modelos, invisível no seletor.
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
  { id: 'ollama', name: 'Ollama', baseURL: 'http://localhost:11434/v1' },
  { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
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
 * Atualiza os modelos de um provedor personalizado a partir do próprio
 * endpoint (botão "buscar modelos" do card). Usado tanto para servidores
 * locais quanto para gateways que ganharam modelos novos.
 */
export async function refreshProviderModels(id: string): Promise<CatalogProvider> {
  const provider = await getCustomProvider(id)
  if (!provider) throw new Error('Provedor não encontrado.')
  if (!provider.api) throw new Error('O provedor não tem URL base configurada.')

  const apiKey = await resolveApiKey(provider.id, provider.env)
  const models = await discoverModels({
    baseURL: provider.api,
    apiKey,
    protocol: provider.protocol,
  })
  const updated = await applyDiscoveredModels(id, models)
  if (!updated) throw new Error('Provedor não encontrado.')
  return updated
}

/**
 * Descoberta a partir do diálogo de edição: a URL e o protocolo vêm do que está
 * na tela, mas a CHAVE pode já estar salva — sem isso, editar um provedor e
 * pedir "buscar modelos" responderia 401 mesmo com a credencial gravada.
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
