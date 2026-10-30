import type { Catalog } from '@shared/chat'
import type { ModelBenchmarks, ModelScores, OrbitModel, PriceTier, SpeedTier } from '@shared/models'
import type { AAModel } from './artificial-analysis'
import type { OpenRouterModel } from './openrouter'

/**
 * Orbit Ranking Engine — merges OpenRouter + Artificial Analysis + models.dev
 * into a single catalog (OrbitModel[]) with scores normalized 0→100.
 */

/** Comparison key: lowercase, alphanumeric only ("claude-opus-4.6" ≡ "claude_opus_46") */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Id suffix without the provider prefix ("anthropic/claude-x" → "claude-x") */
function idSuffix(id: string): string {
  const slash = id.indexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

/** Reads the first numeric field whose name contains every fragment */
function readEval(evals: Record<string, number | null | undefined> | undefined, ...fragments: string[]): number | undefined {
  if (!evals) return undefined
  for (const key of Object.keys(evals)) {
    const norm = key.toLowerCase()
    if (fragments.every((f) => norm.includes(f))) {
      const value = evals[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
  }
  return undefined
}

function priceTierOf(input: number, output: number): PriceTier {
  if (input <= 0 && output <= 0) return 'free'
  const blended = (3 * input + output) / 4
  if (blended < 1) return 'low'
  if (blended < 8) return 'medium'
  return 'premium'
}

function speedTierOf(tokensPerSecond: number | undefined, reasoning: boolean, reasoningMandatory: boolean): SpeedTier {
  if (reasoningMandatory) return 'deep'
  if (tokensPerSecond !== undefined) {
    if (tokensPerSecond >= 100) return 'fast'
    if (tokensPerSecond < 40 && reasoning) return 'deep'
    return 'balanced'
  }
  return reasoning ? 'deep' : 'balanced'
}

interface BuildInput {
  openRouter: OpenRouterModel[]
  aa: AAModel[]
  catalog: Catalog
}

/** Availability via models.dev: normalized model key → provider ids */
function buildAvailabilityIndex(catalog: Catalog): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const providerId in catalog) {
    for (const modelId in catalog[providerId].models) {
      const key = normalizeKey(modelId)
      if (!index.has(key)) index.set(key, new Set())
      index.get(key)!.add(providerId)
    }
  }
  return index
}

/** Input modalities via models.dev: normalized model key → set of modalities */
function buildModalitiesIndex(catalog: Catalog): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const providerId in catalog) {
    for (const modelId in catalog[providerId].models) {
      const input = catalog[providerId].models[modelId].modalities?.input
      if (!input || input.length === 0) continue
      const key = normalizeKey(modelId)
      if (!index.has(key)) index.set(key, new Set())
      for (const m of input) index.get(key)!.add(m)
    }
  }
  return index
}

interface RawModel {
  id: string
  name: string
  provider: string
  providerName: string
  contextWindow: number
  pricing: { input: number; output: number }
  benchmarks: ModelBenchmarks
  reasoning: boolean
  reasoningMandatory: boolean
  vision: boolean
  toolCall: boolean
  modalities: string[]
  releaseDate?: string
  sources: OrbitModel['sources']
  matchKeys: string[]
}

function fromOpenRouter(m: OpenRouterModel): RawModel {
  const [providerSlug] = m.id.split('/')
  const providerName = m.name.includes(':') ? m.name.split(':')[0].trim() : providerSlug
  const aa = m.benchmarks?.artificial_analysis
  // OpenRouter pricing is USD per token — convert to USD per 1M
  const input = Number(m.pricing?.prompt ?? 0) * 1_000_000
  const output = Number(m.pricing?.completion ?? 0) * 1_000_000
  return {
    id: m.id,
    name: m.name.includes(':') ? m.name.split(':').slice(1).join(':').trim() : m.name,
    provider: providerSlug,
    providerName,
    contextWindow: m.context_length ?? m.top_provider?.context_length ?? 0,
    pricing: { input, output },
    benchmarks: {
      intelligenceIndex: aa?.intelligence_index,
      codingIndex: aa?.coding_index,
      agenticIndex: aa?.agentic_index,
    },
    reasoning: Boolean(m.reasoning) || (m.supported_parameters ?? []).includes('reasoning'),
    reasoningMandatory: m.reasoning?.mandatory ?? false,
    vision: (m.architecture?.input_modalities ?? []).includes('image'),
    toolCall: (m.supported_parameters ?? []).includes('tools'),
    modalities: m.architecture?.input_modalities ?? [],
    releaseDate: m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : undefined,
    sources: ['openrouter'],
    matchKeys: [normalizeKey(idSuffix(m.id)), normalizeKey(idSuffix(m.canonical_slug ?? m.id)), normalizeKey(m.name)],
  }
}

function aaBenchmarks(m: AAModel): ModelBenchmarks {
  const evals = m.evaluations
  return {
    intelligenceIndex: readEval(evals, 'intelligence', 'index'),
    codingIndex: readEval(evals, 'coding', 'index'),
    agenticIndex: readEval(evals, 'agentic', 'index'),
    swebench: readEval(evals, 'swe'),
    livecodebench: readEval(evals, 'livecodebench'),
    gpqa: readEval(evals, 'gpqa'),
    hle: readEval(evals, 'hle') ?? readEval(evals, 'humanity'),
    mmluPro: readEval(evals, 'mmlu'),
    tokensPerSecond: m.median_output_tokens_per_second,
    ttft: m.median_time_to_first_token_seconds,
  }
}

/** Merges the AA benchmarks into a RawModel coming from OpenRouter (AA prevails). */
function mergeAA(target: RawModel, aa: AAModel) {
  const b = aaBenchmarks(aa)
  for (const key of Object.keys(b) as (keyof ModelBenchmarks)[]) {
    if (b[key] !== undefined) target.benchmarks[key] = b[key]
  }
  if (!target.releaseDate && aa.release_date) target.releaseDate = aa.release_date
  if (!target.sources.includes('artificialanalysis')) target.sources.push('artificialanalysis')
}

function fromAA(m: AAModel): RawModel {
  const creator = m.model_creator?.slug ?? m.model_creator?.id ?? 'unknown'
  return {
    id: `${creator}/${m.slug}`,
    name: m.name,
    provider: creator,
    providerName: m.model_creator?.name ?? creator,
    contextWindow: 0,
    pricing: {
      input: m.pricing?.price_1m_input_tokens ?? 0,
      output: m.pricing?.price_1m_output_tokens ?? 0,
    },
    benchmarks: aaBenchmarks(m),
    reasoning: false,
    reasoningMandatory: false,
    vision: false,
    toolCall: false,
    modalities: [],
    releaseDate: m.release_date,
    sources: ['artificialanalysis'],
    matchKeys: [normalizeKey(m.slug), normalizeKey(m.name)],
  }
}

/** Normalizes a value to 0→100 relative to the largest value in the dataset. */
function normalizeScore(value: number | undefined, max: number): number | undefined {
  if (value === undefined || max <= 0) return undefined
  return Math.round(Math.max(0, Math.min(100, (value / max) * 100)))
}

export function buildOrbitModels({ openRouter, aa, catalog }: BuildInput): OrbitModel[] {
  const availabilityIndex = buildAvailabilityIndex(catalog)
  const modalitiesIndex = buildModalitiesIndex(catalog)

  // Base: OpenRouter; index by normalized key to match against the AA
  const raws: RawModel[] = openRouter.map(fromOpenRouter)
  const byKey = new Map<string, RawModel>()
  for (const raw of raws) {
    for (const key of raw.matchKeys) if (key && !byKey.has(key)) byKey.set(key, raw)
  }

  for (const model of aa) {
    const match = byKey.get(normalizeKey(model.slug)) ?? byKey.get(normalizeKey(model.name))
    if (match) mergeAA(match, model)
    else raws.push(fromAA(model))
  }

  // Dataset maxima for the 0→100 normalization
  const max = {
    intelligence: 0,
    coding: 0,
    agentic: 0,
    speed: 0,
  }
  for (const raw of raws) {
    max.intelligence = Math.max(max.intelligence, raw.benchmarks.intelligenceIndex ?? 0)
    max.coding = Math.max(max.coding, raw.benchmarks.codingIndex ?? 0)
    max.agentic = Math.max(max.agentic, raw.benchmarks.agenticIndex ?? 0)
    max.speed = Math.max(max.speed, raw.benchmarks.tokensPerSecond ?? 0)
  }

  return raws.map((raw) => {
    const scores: ModelScores = {
      intelligence: normalizeScore(raw.benchmarks.intelligenceIndex, max.intelligence),
      coding: normalizeScore(raw.benchmarks.codingIndex, max.coding),
      agentic: normalizeScore(raw.benchmarks.agenticIndex, max.agentic),
      speed: normalizeScore(raw.benchmarks.tokensPerSecond, max.speed),
      // Vision has no dedicated index in the current sources — intelligence is used
      // as a proxy, and only when the model accepts images
      vision: raw.vision ? normalizeScore(raw.benchmarks.intelligenceIndex, max.intelligence) : undefined,
    }

    const availability = ['openrouter']
    for (const key of raw.matchKeys) {
      for (const providerId of availabilityIndex.get(key) ?? []) {
        if (!availability.includes(providerId)) availability.push(providerId)
      }
    }
    if (!raw.sources.includes('openrouter')) availability.shift()

    // Modalities: union of what OpenRouter reports with models.dev (which
    // covers video/pdf that OpenRouter does not always list)
    const modalities = [...raw.modalities]
    for (const key of raw.matchKeys) {
      for (const m of modalitiesIndex.get(key) ?? []) {
        if (!modalities.includes(m)) modalities.push(m)
      }
    }

    const priceTier = priceTierOf(raw.pricing.input, raw.pricing.output)
    const tags: string[] = []
    if ((scores.coding ?? 0) >= 60) tags.push('coding')
    if (raw.vision) tags.push('vision')
    if (raw.toolCall || (scores.agentic ?? 0) >= 60) tags.push('agent')
    if (raw.reasoning) tags.push('reasoning')
    if (priceTier === 'free') tags.push('free')

    return {
      id: raw.id,
      name: raw.name,
      provider: raw.provider,
      providerName: raw.providerName,
      contextWindow: raw.contextWindow,
      pricing: raw.pricing,
      priceTier,
      speedTier: speedTierOf(raw.benchmarks.tokensPerSecond, raw.reasoning, raw.reasoningMandatory),
      scores,
      benchmarks: raw.benchmarks,
      availability,
      modalities,
      tags,
      releaseDate: raw.releaseDate,
      sources: raw.sources,
    }
  })
}
