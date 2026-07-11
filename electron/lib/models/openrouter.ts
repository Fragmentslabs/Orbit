import fs from 'node:fs/promises'
import path from 'node:path'
import { dataDir } from '../storage'

/**
 * Fonte OpenRouter — lista pública de modelos (sem chave), com contexto,
 * pricing, modalidades e índices da Artificial Analysis embutidos em
 * `benchmarks.artificial_analysis` para parte dos modelos.
 */

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000 // 24h

export interface OpenRouterModel {
  id: string
  canonical_slug?: string
  name: string
  created?: number
  description?: string
  context_length?: number
  architecture?: {
    modality?: string
    input_modalities?: string[]
    output_modalities?: string[]
  }
  pricing?: {
    prompt?: string
    completion?: string
  }
  top_provider?: {
    context_length?: number
    max_completion_tokens?: number
  }
  supported_parameters?: string[]
  reasoning?: {
    mandatory?: boolean
    default_enabled?: boolean
  }
  benchmarks?: {
    artificial_analysis?: {
      intelligence_index?: number
      coding_index?: number
      agentic_index?: number
    }
  }
}

function cacheFile() {
  return path.join(dataDir(), 'openrouter-models.json')
}

async function readCache(): Promise<{ models: OpenRouterModel[]; fetchedAt: number } | null> {
  try {
    return JSON.parse(await fs.readFile(cacheFile(), 'utf8'))
  } catch {
    return null
  }
}

async function fetchModels(): Promise<OpenRouterModel[] | null> {
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: { 'User-Agent': 'orbit-desktop' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: OpenRouterModel[] }
    const models = body.data ?? []
    if (models.length === 0) return null
    await fs.mkdir(dataDir(), { recursive: true })
    await fs.writeFile(cacheFile(), JSON.stringify({ models, fetchedAt: Date.now() }), 'utf8')
    return models
  } catch {
    return null
  }
}

export async function getOpenRouterModels(force = false): Promise<OpenRouterModel[]> {
  if (!force) {
    const cache = await readCache()
    if (cache) {
      if (Date.now() - cache.fetchedAt > REFRESH_INTERVAL) void fetchModels()
      return cache.models
    }
  }
  return (await fetchModels()) ?? (await readCache())?.models ?? []
}
