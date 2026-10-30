import type { DiscoveredModel, ProviderProtocol } from '@shared/chat'
import { tNow } from './i18n'

/**
 * Discovers the models SERVED by an endpoint, instead of assuming a fixed
 * list: `GET {base}/models` (OpenAI-like) and, in Ollama, the native `/api/tags`,
 * which lists what is installed even in versions where `/v1/models` does not
 * exist. The result is a candidate — whoever decides what enters the catalog is the
 * user (or the automatic adoption of local servers, see detect-local.ts).
 */

const TIMEOUT_MS = 6_000

export interface DiscoverOptions {
  baseURL: string
  apiKey?: string
  protocol?: ProviderProtocol
  /** Provider already saved: the stored key is used when `apiKey` does not come. */
  providerId?: string
}

/**
 * URLs that may list models, in order of preference. The second one only exists
 * when the base URL ends in `/v1` — it is the case of the Ollama seed
 * (`http://localhost:11434/v1`), whose native endpoint is at `/api/tags`.
 */
function candidateUrls(baseURL: string): string[] {
  const base = baseURL.trim().replace(/\/+$/, '')
  const urls = [`${base}/models`]
  if (/\/v1$/.test(base)) urls.push(`${base.slice(0, -3)}/api/tags`)
  return urls
}

function requestHeaders(opts: DiscoverOptions): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const key = opts.apiKey?.trim()
  if (!key) return headers
  if (opts.protocol === 'anthropic-messages') {
    headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.authorization = `Bearer ${key}`
  }
  return headers
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/**
 * Models of a listing response. It accepts the formats that show up in
 * practice: `{ data: [{ id }] }` (OpenAI, LM Studio, gateways), `{ models:
 * [{ name, details }] }` (native Ollama), `{ data: [{ id, display_name }] }`
 * (Anthropic). An item without a recognizable id is ignored.
 */
export function parseModelList(body: unknown): DiscoveredModel[] {
  const root = record(body)
  if (!root) return []
  const list = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : []

  const models: DiscoveredModel[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item === 'string') {
      if (!seen.has(item)) {
        seen.add(item)
        models.push({ id: item })
      }
      continue
    }
    const raw = record(item)
    if (!raw) continue
    const idField = [raw.id, raw.name, raw.model].find((v): v is string => typeof v === 'string')
    if (!idField) continue
    // Ollama returns "llama3.2:latest"; the name with a tag is not the id the chat uses.
    const id = idField.replace(/:latest$/, '')
    if (!id || seen.has(id)) continue
    seen.add(id)

    const details = record(raw.details)
    const discovered: DiscoveredModel = { id }
    if (typeof raw.display_name === 'string') discovered.name = raw.display_name
    const contextWindow = positiveNumber(
      raw.context_length ?? raw.context_window ?? raw.max_context_length ?? details?.context_length,
    )
    if (contextWindow) discovered.contextWindow = contextWindow
    const maxTokens = positiveNumber(raw.max_output_tokens ?? details?.max_output_tokens)
    if (maxTokens) discovered.maxTokens = maxTokens
    models.push(discovered)
  }
  return models
}

/**
 * Queries the candidate URLs and returns the first non-empty result. A
 * server that answers 200 without models (nothing installed) returns an empty list —
 * that is not an error. It only throws when no endpoint answered.
 */
export async function discoverModels(opts: DiscoverOptions): Promise<DiscoveredModel[]> {
  if (!opts.baseURL?.trim()) throw new Error('Informe a URL base do provedor.')

  const headers = requestHeaders(opts)
  const failures: string[] = []
  let answered = false

  for (const url of candidateUrls(opts.baseURL)) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) {
        failures.push(`${url} answered HTTP ${res.status}`)
        continue
      }
      answered = true
      const models = parseModelList(await res.json())
      if (models.length > 0) return models
    } catch (err) {
      failures.push(`${url}: ${(err as Error).message}`)
    }
  }

  if (answered) return []
  throw new Error(failures.join(' · ') || tNow('provider.listModelsFailed'))
}
