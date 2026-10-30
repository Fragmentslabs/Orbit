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
import { tNow } from './i18n'

/**
 * Providers that do not exist in models.dev: local servers (Ollama, LM
 * Studio) and the user's gateways. Unlike models.dev, here the registration
 * carries what the catalog cannot describe — the wire protocol, the
 * models served and the gateway's compatibility tweaks. Without this the
 * provider showed up in Settings and never in the model selector.
 */

export interface CustomProviderEntry {
  provider: CatalogProvider
  createdAt: number
  updatedAt?: number
}

const PROVIDERS_FILE = 'custom-providers.json'

/** The same id format accepted by the `custom:` prefix (see toKey). */
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
 * Models that think before answering. The list is conservative on purpose:
 * marking a model that does not accept the payload as reasoning makes the gateway
 * answer 400; failing to mark it only hides the level control, which the
 * user can still turn on when editing the model in the catalog.
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

/** Accepts `ollama` or `custom:ollama` — the renderer works with one or the other. */
function normalizeId(id: string): string {
  return id.trim().replace(/^custom:/, '')
}

function toKey(id: string): string {
  return `custom:${normalizeId(id)}`
}

/** Name of the environment variable used as the key fallback. */
function defaultEnvName(id: string): string {
  const slug = normalizeId(id).toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  return `CUSTOM_${slug}_KEY`
}

function normalizeBaseURL(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '')
  if (!value) throw new Error('Enter the provider base URL.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid base URL. Example: https://api.example.com/v1')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The base URL must start with http:// or https://')
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

/** `openai-completions` is the default — it does not need to take up space in the file. */
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

/** Writes the key to auth.json and points `env` to its default name. */
async function storeApiKey(provider: CatalogProvider, apiKey: string): Promise<void> {
  await setCredential(provider.id, apiKey.trim())
  provider.env = [defaultEnvName(provider.id)]
}

export async function listCustomProviders(): Promise<CatalogProvider[]> {
  const data = await readAll()
  const entries = Object.values(data).sort((a, b) => a.provider.name.localeCompare(b.provider.name))
  if (entries.length === 0) return []

  // `hasKey` is derived on read (saved credential OR existing environment
  // variable) so the card can say "no key" without exposing the key.
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
    throw new Error(tNow('provider.invalidId'))
  }
  const name = input.name.trim()
  if (!name) throw new Error(tNow('provider.nameRequired'))

  const data = await readAll()
  const key = toKey(id)
  if (data[key]) throw new Error(tNow('provider.idExists', { id }))

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

  // The credential enters auth.json BEFORE the providers file: the provider's `env`
  // comes from storeApiKey, and writing the file first would lose that
  // field (the in-memory provider would be saved without knowing it has a key).
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
  if (!existing) throw new Error(tNow('provider.notFoundWithId', { id: normalizeId(id) }))

  const provider = existing.provider

  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error(tNow('provider.nameRequired'))
    provider.name = name
  }
  if (patch.baseURL !== undefined) provider.api = normalizeBaseURL(patch.baseURL)
  if (patch.protocol !== undefined) applyProtocol(provider, patch.protocol)
  if (patch.compat !== undefined) applyCompat(provider, patch.compat)
  if (patch.models !== undefined) provider.models = modelsRecord(patch.models)

  // Key: environment variable, saved key or none (local server).
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
 * Applies the discovered list to the provider, preserving what was already known about the
 * models that still exist (name, limits, reasoning flag). The
 * server is the source of truth: a model it did not list went offline and leaves
 * the selector — otherwise the list grows forever with what was already uninstalled.
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
 * Ensures the provider of a local detector (Ollama, LM Studio). It serves the
 * explicit detection: if the user deleted the entry, detecting the server
 * running recreates it with the models that are installed.
 */
export async function ensureSeedProvider(id: string): Promise<CatalogProvider | undefined> {
  const seed = SEED_PROVIDERS.find((provider) => provider.id === normalizeId(id))
  if (!seed) return undefined

  const data = await readAll()
  const key = toKey(seed.id)
  if (!data[key]) {
    // The id written carries the `custom:` prefix like any other custom one:
    // without it the seed was confused with the provider of the same id from models.dev
    // (lmstudio) and escaped the custom list in the interface.
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
 * Writes the local providers only on the FIRST run (nonexistent file).
 * Seeding on every opening resurrected the Ollama the user had deleted.
 * It also fixes ids written by older versions (see the comment below).
 */
export async function seedCustomProviders(): Promise<void> {
  const data = await readAll()
  let changed = false

  // Migration: the old seed was written under the key `custom:ollama` with
  // provider.id = "ollama" — the provider passed itself off as the one with the same id from
  // models.dev (lmstudio) and escaped the custom list in the interface.
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
