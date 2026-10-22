import type { DiscoveredModel, ProviderProtocol } from '@shared/chat'

/**
 * Descobre os modelos SERVIDOS por um endpoint, em vez de assumir uma lista
 * fixa: `GET {base}/models` (OpenAI-like) e, em Ollama, o `/api/tags` nativo,
 * que lista o que está instalado mesmo em versões em que o `/v1/models` não
 * existe. O resultado é candidato — quem decide o que entra no catálogo é o
 * usuário (ou a adoção automática dos servidores locais, ver detect-local.ts).
 */

const TIMEOUT_MS = 6_000

export interface DiscoverOptions {
  baseURL: string
  apiKey?: string
  protocol?: ProviderProtocol
  /** Provedor já salvo: a chave guardada é usada quando `apiKey` não vem. */
  providerId?: string
}

/**
 * URLs que podem listar modelos, na ordem de preferência. A segunda só existe
 * quando a URL base termina em `/v1` — é o caso do seed de Ollama
 * (`http://localhost:11434/v1`), cujo endpoint nativo fica em `/api/tags`.
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
 * Modelos de uma resposta de listagem. Aceita os formatos que aparecem na
 * prática: `{ data: [{ id }] }` (OpenAI, LM Studio, gateways), `{ models:
 * [{ name, details }] }` (Ollama nativo), `{ data: [{ id, display_name }] }`
 * (Anthropic). Item que não tem id reconhecível é ignorado.
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
    // Ollama devolve "llama3.2:latest"; o nome com tag não é o id que o chat usa.
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
 * Consulta as URLs candidatas e devolve o primeiro resultado não vazio. Um
 * servidor que responde 200 sem modelos (nada instalado) devolve lista vazia —
 * não é erro. Só lança quando nenhum endpoint respondeu.
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
        failures.push(`${url} respondeu HTTP ${res.status}`)
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
  throw new Error(failures.join(' · ') || 'Não foi possível listar os modelos do servidor.')
}
