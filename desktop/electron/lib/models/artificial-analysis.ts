import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveApiKey } from '../auth'
import { dataDir } from '../storage'

/**
 * Fonte Artificial Analysis — índices de inteligência/coding/agentic,
 * benchmarks individuais (GPQA, HLE, SWE-Bench…) e métricas de velocidade
 * (tokens/s, TTFT). Requer chave de API gratuita, salva no auth.json sob o
 * id "artificialanalysis" (ou env ARTIFICIALANALYSIS_API_KEY).
 */

const AA_MODELS_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models'
const AA_PROVIDER_ID = 'artificialanalysis'
const AA_ENV_NAMES = ['ARTIFICIALANALYSIS_API_KEY', 'ARTIFICIAL_ANALYSIS_API_KEY']
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000 // 24h

export interface AAModel {
  id: string
  name: string
  slug: string
  release_date?: string
  model_creator?: { id?: string; name?: string; slug?: string }
  /** Nomes de campo variam conforme a AA adiciona benchmarks — ler defensivamente */
  evaluations?: Record<string, number | null | undefined>
  pricing?: {
    price_1m_input_tokens?: number
    price_1m_output_tokens?: number
    price_1m_blended_3_to_1?: number
  }
  median_output_tokens_per_second?: number
  median_time_to_first_token_seconds?: number
}

function cacheFile() {
  return path.join(dataDir(), 'artificial-analysis-models.json')
}

async function readCache(): Promise<{ models: AAModel[]; fetchedAt: number } | null> {
  try {
    return JSON.parse(await fs.readFile(cacheFile(), 'utf8'))
  } catch {
    return null
  }
}

export async function hasAAKey(): Promise<boolean> {
  return Boolean(await resolveApiKey(AA_PROVIDER_ID, AA_ENV_NAMES))
}

async function fetchModels(): Promise<AAModel[] | null> {
  const key = await resolveApiKey(AA_PROVIDER_ID, AA_ENV_NAMES)
  if (!key) return null
  try {
    const res = await fetch(AA_MODELS_URL, {
      headers: { 'x-api-key': key, 'User-Agent': 'orbit-desktop' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: AAModel[] }
    const models = body.data ?? []
    if (models.length === 0) return null
    await fs.mkdir(dataDir(), { recursive: true })
    await fs.writeFile(cacheFile(), JSON.stringify({ models, fetchedAt: Date.now() }), 'utf8')
    return models
  } catch {
    return null
  }
}

/** Retorna [] quando não há chave nem cache — a aba funciona só com o OpenRouter. */
export async function getAAModels(force = false): Promise<AAModel[]> {
  if (!force) {
    const cache = await readCache()
    if (cache) {
      if (Date.now() - cache.fetchedAt > REFRESH_INTERVAL) void fetchModels()
      return cache.models
    }
  }
  return (await fetchModels()) ?? (await readCache())?.models ?? []
}
