import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  CatalogModel,
  CatalogProvider,
  CustomModelInput,
  CustomProviderInput,
  CustomProviderPatch,
  DiscoveredModel,
  ProviderCompat,
  ProviderProtocol,
} from '@shared/chat'
import { listCredentialProviders, removeCredential, setCredential } from './auth'
import { dataDir } from './storage'

/**
 * Provedores que não existem no models.dev: servidores locais (Ollama, LM
 * Studio) e gateways do usuário. Diferente do models.dev, aqui o cadastro
 * carrega o que o catálogo não tem como descrever — o protocolo de fio, os
 * modelos servidos e os ajustes de compatibilidade do gateway. Sem isso o
 * provedor aparecia nas Configurações e nunca no seletor de modelos.
 */

export interface CustomProviderEntry {
  provider: CatalogProvider
  createdAt: number
  updatedAt?: number
}

const PROVIDERS_FILE = 'custom-providers.json'

/** Mesmo formato de id aceito pelo prefixo `custom:` (ver toKey). */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i

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

/**
 * Modelos que pensam antes de responder. A lista é conservadora de propósito:
 * marcar como reasoning um modelo que não aceita o payload faz o gateway
 * responder 400; deixar de marcar só esconde o controle de nível, que o
 * usuário ainda pode ligar ao editar o modelo no catálogo.
 */
const REASONING_ID_RE =
  /(^|[^a-z0-9])(r1|reasoner|reasoning|thinking|think|qwq|qwen3|gpt-5|glm-4[.-]5|glm-5|kimi-k2|magistral|minimax-m2)([^a-z0-9]|$)/i
const OPENAI_REASONING_ID_RE = /(^|[^a-z0-9])o[134](-|$)/i

export function inferReasoning(modelId: string): boolean {
  return REASONING_ID_RE.test(modelId) || OPENAI_REASONING_ID_RE.test(modelId)
}

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

/** Aceita `ollama` ou `custom:ollama` — o renderer trabalha ora com um, ora com outro. */
function normalizeId(id: string): string {
  return id.trim().replace(/^custom:/, '')
}

function toKey(id: string): string {
  return `custom:${normalizeId(id)}`
}

/** Nome da variável de ambiente usada como fallback da chave. */
function defaultEnvName(id: string): string {
  const slug = normalizeId(id).toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  return `CUSTOM_${slug}_KEY`
}

function normalizeBaseURL(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '')
  if (!value) throw new Error('Informe a URL base do provedor.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('URL base inválida. Exemplo: https://api.exemplo.com/v1')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('A URL base precisa começar com http:// ou https://')
  }
  return value
}

function toCatalogModel(input: CustomModelInput): CatalogModel {
  const id = input.id.trim()
  const model: CatalogModel = {
    id,
    name: input.name?.trim() || id,
    reasoning: input.reasoning ?? inferReasoning(id),
    tool_call: true,
    attachment: false,
  }
  if (input.contextWindow || input.maxTokens) {
    model.limit = { context: input.contextWindow ?? 0, output: input.maxTokens ?? 0 }
  }
  return model
}

function modelsRecord(models: CustomModelInput[] | undefined): Record<string, CatalogModel> {
  const record: Record<string, CatalogModel> = {}
  for (const model of models ?? []) {
    const id = model.id?.trim()
    if (!id) continue
    record[id] = toCatalogModel({ ...model, id })
  }
  return record
}

/** `openai-completions` é o padrão — não precisa ocupar espaço no arquivo. */
function applyProtocol(provider: CatalogProvider, protocol: ProviderProtocol | undefined): void {
  if (protocol && protocol !== 'openai-completions') provider.protocol = protocol
  else delete provider.protocol
}

function applyCompat(provider: CatalogProvider, compat: ProviderCompat | null | undefined): void {
  delete provider.compat
  if (!compat) return
  const clean: ProviderCompat = {}
  if (compat.maxTokensField === 'max_completion_tokens') clean.maxTokensField = compat.maxTokensField
  if (compat.thinkingFormat) clean.thinkingFormat = compat.thinkingFormat
  if (Object.keys(clean).length > 0) provider.compat = clean
}

/** Grava a chave em auth.json e aponta o `env` para o nome padrão dela. */
async function storeApiKey(provider: CatalogProvider, apiKey: string): Promise<void> {
  await setCredential(provider.id, apiKey.trim())
  provider.env = [defaultEnvName(provider.id)]
}

export async function listCustomProviders(): Promise<CatalogProvider[]> {
  const data = await readAll()
  const entries = Object.values(data).sort((a, b) => a.provider.name.localeCompare(b.provider.name))
  if (entries.length === 0) return []

  // `hasKey` é derivado na leitura (credencial salva OU variável de ambiente
  // existente) para o card conseguir dizer "sem chave" sem expor a chave.
  const credentials = new Set(await listCredentialProviders())
  return entries.map((entry) => {
    const provider = entry.provider
    const hasKey =
      credentials.has(provider.id) || provider.env.some((name) => !!process.env[name])
    return { ...provider, hasKey }
  })
}

export async function getCustomProvider(id: string): Promise<CatalogProvider | undefined> {
  const data = await readAll()
  return data[toKey(id)]?.provider
}

export async function addCustomProvider(input: CustomProviderInput): Promise<CatalogProvider> {
  const id = normalizeId(input.id)
  if (!ID_RE.test(id)) {
    throw new Error('ID inválido: use letras, números, "-" e "_" (sem espaços).')
  }
  const name = input.name.trim()
  if (!name) throw new Error('Informe um nome para o provedor.')

  const data = await readAll()
  const key = toKey(id)
  if (data[key]) throw new Error(`Já existe um provedor com o ID "${id}".`)

  const provider: CatalogProvider = {
    id: key,
    name,
    env: [],
    api: normalizeBaseURL(input.baseURL),
    models: modelsRecord(input.models),
  }
  applyProtocol(provider, input.protocol)
  applyCompat(provider, input.compat)

  const keyEnv = input.keyEnv?.trim()
  if (keyEnv) provider.env = [keyEnv]

  // A credencial entra em auth.json ANTES do arquivo de provedores: o `env`
  // do provedor vem de storeApiKey, e gravar o arquivo primeiro perderia esse
  // campo (o provider em memória seria salvo sem saber que tem chave).
  if (input.apiKey?.trim() && !keyEnv) await storeApiKey(provider, input.apiKey)

  data[key] = { provider, createdAt: Date.now() }
  await writeAll(data)
  return provider
}

export async function removeCustomProvider(id: string): Promise<void> {
  const data = await readAll()
  const key = toKey(id)
  const removed = data[key]
  delete data[key]
  await writeAll(data)

  if (removed) await removeCredential(removed.provider.id)
}

export async function updateCustomProvider(
  id: string,
  patch: CustomProviderPatch,
): Promise<CatalogProvider> {
  const data = await readAll()
  const key = toKey(id)
  const existing = data[key]
  if (!existing) throw new Error(`Provedor "${normalizeId(id)}" não encontrado.`)

  const provider = existing.provider

  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error('Informe um nome para o provedor.')
    provider.name = name
  }
  if (patch.baseURL !== undefined) provider.api = normalizeBaseURL(patch.baseURL)
  if (patch.protocol !== undefined) applyProtocol(provider, patch.protocol)
  if (patch.compat !== undefined) applyCompat(provider, patch.compat)
  if (patch.models !== undefined) provider.models = modelsRecord(patch.models)

  // Chave: variável de ambiente, chave salva ou nenhuma (servidor local).
  if (patch.keyEnv !== undefined) {
    const envName = patch.keyEnv?.trim()
    if (envName) {
      provider.env = [envName]
      await removeCredential(provider.id)
    } else if (!patch.apiKey?.trim()) {
      provider.env = []
      await removeCredential(provider.id)
    }
  }
  if (patch.apiKey?.trim()) await storeApiKey(provider, patch.apiKey)

  data[key] = { ...existing, provider, updatedAt: Date.now() }
  await writeAll(data)
  return provider
}

/**
 * Aplica a lista descoberta no provedor, preservando o que já se sabia dos
 * modelos que continuam existindo (nome, limites, flag de reasoning). O
 * servidor é a fonte da verdade: modelo que ele não listou saiu do ar e deixa
 * o seletor — senão a lista cresce para sempre com o que já foi desinstalado.
 */
export async function applyDiscoveredModels(
  id: string,
  discovered: DiscoveredModel[],
): Promise<CatalogProvider | undefined> {
  const data = await readAll()
  const key = toKey(id)
  const existing = data[key]
  if (!existing) return undefined

  const provider = existing.provider
  const models: Record<string, CatalogModel> = {}
  for (const found of discovered) {
    const previous = provider.models[found.id]
    models[found.id] = toCatalogModel({
      id: found.id,
      name: found.name ?? previous?.name,
      contextWindow: found.contextWindow ?? previous?.limit?.context,
      maxTokens: found.maxTokens ?? previous?.limit?.output,
      reasoning: previous?.reasoning,
    })
  }
  provider.models = models

  data[key] = { ...existing, provider, updatedAt: Date.now() }
  await writeAll(data)
  return provider
}

/**
 * Garante o provedor de um detector local (Ollama, LM Studio). Serve para a
 * detecção explícita: se o usuário apagou a entrada, detectar o servidor
 * rodando a recria com os modelos que estão instalados.
 */
export async function ensureSeedProvider(id: string): Promise<CatalogProvider | undefined> {
  const seed = SEED_PROVIDERS.find((provider) => provider.id === normalizeId(id))
  if (!seed) return undefined

  const data = await readAll()
  const key = toKey(seed.id)
  if (!data[key]) {
    // O id gravado leva o prefixo `custom:` como qualquer outro personalizado:
    // sem isso o seed se confundia com o provedor de mesmo id do models.dev
    // (lmstudio) e escapava da lista de personalizados na interface.
    data[key] = { provider: { ...seed, id: key, models: {} }, createdAt: Date.now() }
    await writeAll(data)
  }
  return data[key]?.provider
}

async function fileExists(): Promise<boolean> {
  try {
    await fs.access(filePath())
    return true
  } catch {
    return false
  }
}

/**
 * Escreve os provedores locais só na PRIMEIRA execução (arquivo inexistente).
 * Semear a cada abertura ressuscitava o Ollama que o usuário tinha apagado.
 * Também conserta ids gravados por versões antigas (ver comentário abaixo).
 */
export async function seedCustomProviders(): Promise<void> {
  const data = await readAll()
  let changed = false

  // Migração: o seed antigo era gravado na chave `custom:ollama` com
  // provider.id = "ollama" — o provedor se passava pelo de mesmo id do
  // models.dev (lmstudio) e escapava da lista de personalizados na interface.
  for (const [key, entry] of Object.entries(data)) {
    if (entry.provider.id !== key) {
      entry.provider.id = key
      changed = true
    }
  }

  if (!(await fileExists())) {
    for (const seed of SEED_PROVIDERS) {
      const key = toKey(seed.id)
      data[key] = { provider: { ...seed, id: key, models: {} }, createdAt: Date.now() }
    }
    changed = true
  }

  if (changed) await writeAll(data)
}
