import type { CatalogModel } from '@shared/chat'
import type { ModelInput, VariantMap, VariantPayload } from './types'

/** Converts a model from the models.dev catalog into the module's internal input. */
export function toModelInput(
  providerId: string,
  npm: string | undefined,
  model: CatalogModel,
  apiUrl?: string,
): ModelInput {
  return {
    providerId,
    modelId: model.id,
    npm: npm ?? '@ai-sdk/openai-compatible',
    apiId: model.id,
    releaseDate: model.release_date ?? '',
    reasoning: model.reasoning,
    limit: model.limit ?? { context: 0, output: 0 },
    reasoningOptions: model.reasoning_options,
    apiUrl,
  }
}

/**
 * Generation of reasoning levels (variants) per provider. What the catalog
 * declares for the model on that provider wins first (catalogVariants); without
 * that, the rules by model name and by SDK (ruleVariants).
 */

const WIDELY_SUPPORTED_EFFORTS = ['low', 'medium', 'high']
const OPENAI_EFFORTS = ['none', 'minimal', ...WIDELY_SUPPORTED_EFFORTS, 'xhigh']
const OPENAI_GPT5_1_EFFORTS = ['none', ...WIDELY_SUPPORTED_EFFORTS]
const OPENAI_GPT5_2_PLUS_EFFORTS = [...OPENAI_GPT5_1_EFFORTS, 'xhigh']
const OPENAI_GPT5_PRO_EFFORTS = ['high']
const OPENAI_GPT5_PRO_2_PLUS_EFFORTS = ['medium', 'high', 'xhigh']
const OPENAI_GPT5_CHAT_EFFORTS = ['medium']
const OPENAI_GPT5_CODEX_XHIGH_EFFORTS = [...WIDELY_SUPPORTED_EFFORTS, 'xhigh']
const OPENAI_GPT5_CODEX_3_PLUS_EFFORTS = ['none', ...OPENAI_GPT5_CODEX_XHIGH_EFFORTS]

// OpenAI released the `none` tier of reasoning_effort on this date (Responses API).
// Earlier models return 400 with `reasoning_effort: "none"`, so we only
// expose the tier for models new enough.
const OPENAI_NONE_EFFORT_RELEASE_DATE = '2025-11-13'

// Same logic for the `xhigh` tier.
const OPENAI_XHIGH_EFFORT_RELEASE_DATE = '2025-12-04'

// Required for stateless multi-turn reasoning (store: false).
const INCLUDE_ENCRYPTED_REASONING = ['reasoning.encrypted_content']

// Matches members of the gpt-5 family in the id formats found:
//   "gpt-5", "gpt-5-nano", "gpt-5.4", "openai/gpt-5.4-codex".
// Anchored at start-of-string or "/" so it does not match "gpt-50" or "gpt-5o".
const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/
const GPT5_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
const GPT5_PRO_RE = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/
const GPT5_VERSIONED_PRO_RE = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/

function gpt5Version(apiId: string) {
  return Number(GPT5_VERSION_RE.exec(apiId)?.[1]) || undefined
}

function versionedGpt5ReasoningEfforts(apiId: string) {
  if (GPT5_VERSIONED_PRO_RE.test(apiId)) return OPENAI_GPT5_PRO_2_PLUS_EFFORTS
  const version = gpt5Version(apiId)
  if (version === undefined) return undefined
  if (version === 1) return OPENAI_GPT5_1_EFFORTS
  return OPENAI_GPT5_2_PLUS_EFFORTS
}

function gpt5CodexReasoningEfforts(apiId: string) {
  if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes('codex')) return undefined
  const version = gpt5Version(apiId)
  if (version !== undefined && version >= 3) return OPENAI_GPT5_CODEX_3_PLUS_EFFORTS
  if (apiId.includes('codex-max') || (version !== undefined && version >= 2)) return OPENAI_GPT5_CODEX_XHIGH_EFFORTS
  return WIDELY_SUPPORTED_EFFORTS
}

function gpt5ChatReasoningEfforts(apiId: string) {
  if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes('-chat')) return undefined
  return gpt5Version(apiId) === undefined ? [] : OPENAI_GPT5_CHAT_EFFORTS
}

// reasoning_effort tiers an OpenAI model exposes, from the weakest to the strongest.
function openaiReasoningEfforts(apiId: string, releaseDate: string) {
  const id = apiId.toLowerCase()
  if (id.includes('deep-research')) return ['medium']
  const chatEfforts = gpt5ChatReasoningEfforts(id)
  if (chatEfforts) return chatEfforts
  if (GPT5_PRO_RE.test(id)) return OPENAI_GPT5_PRO_EFFORTS
  const codexEfforts = gpt5CodexReasoningEfforts(id)
  if (codexEfforts) return codexEfforts
  // GPT-5.1 swapped GPT-5's `minimal` for `none`; GPT-5.2+ accepts `xhigh`.
  const versionedEfforts = versionedGpt5ReasoningEfforts(id)
  if (versionedEfforts) return versionedEfforts
  const efforts = [...WIDELY_SUPPORTED_EFFORTS]
  if (GPT5_FAMILY_RE.test(id)) efforts.unshift('minimal')
  if (releaseDate >= OPENAI_NONE_EFFORT_RELEASE_DATE) efforts.unshift('none')
  if (releaseDate >= OPENAI_XHIGH_EFFORT_RELEASE_DATE) efforts.push('xhigh')
  return efforts
}

function openaiCompatibleReasoningEfforts(apiId: string) {
  const id = apiId.toLowerCase()
  const chatEfforts = gpt5ChatReasoningEfforts(id)
  if (chatEfforts) return chatEfforts
  if (GPT5_PRO_RE.test(id)) return OPENAI_GPT5_PRO_EFFORTS
  return gpt5CodexReasoningEfforts(id) ?? versionedGpt5ReasoningEfforts(id) ?? OPENAI_EFFORTS
}

function anthropicOpus47OrLater(apiId: string) {
  // Matches "opus-4.7" (Anthropic/Bedrock/Vertex) and "claude-4.7-opus" (inverted).
  // Versions limited to 1-2 digits so date suffixes
  // ("claude-opus-4-20250514") are not confused with a version number.
  const version = /opus-(\d{1,2})[.-](\d{1,2})(?:[.@-]|$)|claude-(\d{1,2})[.-](\d{1,2})-opus(?:[.@-]|$)/i.exec(apiId)
  if (!version) return false
  const major = Number(version[1] ?? version[3])
  const minor = Number(version[2] ?? version[4])
  return major > 4 || (major === 4 && minor >= 7)
}

function anthropicSonnet5OrLater(apiId: string) {
  const version = /sonnet-(\d{1,2})(?:[.@-]|$)|claude-(\d{1,2})-sonnet(?:[.@-]|$)/i.exec(apiId)
  if (!version) return false
  return Number(version[1] ?? version[2]) >= 5
}

function anthropicAdaptiveEfforts(apiId: string): string[] | null {
  if (anthropicOpus47OrLater(apiId) || anthropicSonnet5OrLater(apiId) || apiId.includes('fable-5')) {
    return ['low', 'medium', 'high', 'xhigh', 'max']
  }
  if (
    ['opus-4-6', 'opus-4.6', '4-6-opus', '4.6-opus', 'sonnet-4-6', 'sonnet-4.6', '4-6-sonnet', '4.6-sonnet'].some(
      (v) => apiId.includes(v),
    )
  ) {
    return ['low', 'medium', 'high', 'max']
  }
  return null
}

// Newer adaptive models use the "omitted" display by default, returning
// empty thinking blocks — we force "summarized" to preserve summaries.
function anthropicOmitsThinking(apiId: string) {
  return anthropicOpus47OrLater(apiId) || anthropicSonnet5OrLater(apiId) || apiId.includes('fable-5')
}

function anthropicOpus45(apiId: string) {
  return ['opus-4-5', 'opus-4.5'].some((v) => apiId.includes(v))
}

/** Kimi by any path: provider id, model id or the Moonshot URL. */
export function isKimiFamily(model: ModelInput) {
  if ([model.providerId, model.apiId].some((id) => /kimi|moonshot/i.test(id))) return true
  const url = model.apiUrl?.toLowerCase() ?? ''
  return ['api.kimi.com', 'api.moonshot.ai', 'api.moonshot.cn', 'api.moonshotai.cn'].some((host) => url.includes(host))
}

/** GLM-5.2 is the first GLM with effort levels — the earlier ones only think. */
function isGlm52(model: ModelInput) {
  return [model.modelId, model.apiId].some((id) => /glm-5[.p-]2/i.test(id))
}

const isAnthropicSdk = (npm: string) => npm === '@ai-sdk/anthropic' || npm === '@ai-sdk/google-vertex/anthropic'

/** Output token cap used in the reasoning budget. */
const OUTPUT_TOKEN_MAX = 32_000

function anthropicEffortPayload(model: ModelInput, effort: string): VariantPayload | undefined {
  if (anthropicOpus45(model.apiId)) {
    const output = model.limit.output || OUTPUT_TOKEN_MAX
    return { thinking: { type: 'enabled', budgetTokens: Math.min(16_000, Math.floor(output / 2 - 1)) }, effort }
  }
  // Kimi omits the adaptive thinking text without the "summarized" display.
  if (isKimiFamily(model)) return { thinking: { type: 'adaptive', display: 'summarized' }, effort }
  if (!anthropicAdaptiveEfforts(model.apiId)) return undefined
  return {
    thinking: { type: 'adaptive', ...(anthropicOmitsThinking(model.apiId) ? { display: 'summarized' } : {}) },
    effort,
  }
}

/**
 * Payload of an effort level declared by the catalog, in the format the provider's
 * SDK reads. `undefined` = that SDK does not accept levels (the level disappears).
 */
function effortPayload(model: ModelInput, effort: string): VariantPayload | undefined {
  switch (model.npm) {
    case '@openrouter/ai-sdk-provider':
      return { reasoning: { effort } }
    case '@ai-sdk/anthropic':
    case '@ai-sdk/google-vertex/anthropic':
      return anthropicEffortPayload(model, effort) ?? { effort }
    case '@ai-sdk/google':
    case '@ai-sdk/google-vertex':
      return { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }
    case '@ai-sdk/amazon-bedrock':
      if (anthropicAdaptiveEfforts(model.apiId)) {
        return {
          reasoningConfig: {
            type: 'adaptive',
            maxReasoningEffort: effort,
            ...(anthropicOmitsThinking(model.apiId) ? { display: 'summarized' } : {}),
          },
        }
      }
      if (anthropicOpus45(model.apiId)) {
        const output = model.limit.output || OUTPUT_TOKEN_MAX
        return {
          reasoningConfig: {
            type: 'enabled',
            budgetTokens: Math.min(16_000, Math.floor(output / 2 - 1)),
            maxReasoningEffort: effort,
          },
        }
      }
      if (model.apiId.includes('anthropic')) return undefined
      return { reasoningConfig: { type: 'enabled', maxReasoningEffort: effort } }
    case '@ai-sdk/openai':
    case '@ai-sdk/azure':
      return { reasoningEffort: effort, reasoningSummary: 'auto', include: INCLUDE_ENCRYPTED_REASONING }
    case '@ai-sdk/cohere':
    case '@ai-sdk/alibaba':
    case '@ai-sdk/perplexity':
    case '@ai-sdk/vercel':
      return undefined
    default:
      // openai-compatible adapter and the others that read `reasoningEffort`.
      return { reasoningEffort: effort }
  }
}

/** Payload of a reasoning token budget, per SDK. */
function budgetPayload(model: ModelInput, budget: number): VariantPayload | undefined {
  switch (model.npm) {
    case '@openrouter/ai-sdk-provider':
      return { reasoning: { max_tokens: budget } }
    case '@ai-sdk/anthropic':
    case '@ai-sdk/google-vertex/anthropic':
      return { thinking: { type: 'enabled', budgetTokens: budget } }
    case '@ai-sdk/google':
    case '@ai-sdk/google-vertex':
      return { thinkingConfig: { includeThoughts: true, thinkingBudget: budget } }
    case '@ai-sdk/amazon-bedrock':
      return { reasoningConfig: { type: 'enabled', budgetTokens: budget } }
    case '@ai-sdk/cohere':
      return { thinking: { type: 'enabled', tokenBudget: budget } }
    case '@ai-sdk/alibaba':
      return { enableThinking: true, thinkingBudget: budget }
    default:
      return undefined
  }
}

/**
 * On/off declared by the catalog. It only exists where the SDK has a known
 * field for it; in the others (including the openai-compatible adapter)
 * there is no field common across gateways, and the model falls back to the rules by name.
 */
function toggleVariants(model: ModelInput): VariantMap {
  if (model.npm === '@ai-sdk/alibaba') return { none: { enableThinking: false }, high: { enableThinking: true } }
  if (model.npm === '@ai-sdk/cohere') {
    return { none: { thinking: { type: 'disabled' } }, high: { thinking: { type: 'enabled' } } }
  }
  return {}
}

function budgetVariants(model: ModelInput, min?: number, max?: number): VariantMap {
  const output = model.limit.output || OUTPUT_TOKEN_MAX
  const maximum = Math.min(max ?? OUTPUT_TOKEN_MAX - 1, output - 1, OUTPUT_TOKEN_MAX - 1)
  if (maximum <= 0) return {}
  const high = Math.min(Math.max(min ?? 0, Math.floor((maximum + 1) / 2)), maximum)
  const variants: VariantMap = {}
  for (const [id, budget] of [['high', high], ['max', maximum]] as const) {
    const payload = budgetPayload(model, budget)
    if (payload) variants[id] = payload
  }
  return variants
}

const nonEmpty = (variants: VariantMap): VariantMap | undefined =>
  Object.keys(variants).length > 0 ? variants : undefined

/**
 * Levels that models.dev declares for the model on THIS provider. The same
 * model accepts different levels on each gateway (DeepSeek V4.1 Flash is
 * low/high/max on one and none…max on DeepInfra), and the fixed list per family
 * got it wrong — it offered "medium" where none exists.
 *
 * `undefined` = the catalog does not resolve it, and the rules by model name apply.
 */
function catalogVariants(model: ModelInput): VariantMap | undefined {
  const options = model.reasoningOptions
  if (options === undefined) return undefined
  if (options.length === 0) return {}

  const effort = options.find((o) => o.type === 'effort')
  if (effort) {
    const variants: VariantMap = {}
    for (const value of effort.values) {
      const id = value === null ? 'none' : value
      if (typeof id !== 'string') continue
      const payload = effortPayload(model, id)
      if (payload) variants[id] = payload
    }
    return variants
  }

  const toggle = options.some((o) => o.type === 'toggle')
  const budget = options.find((o) => o.type === 'budget_tokens')
  if (!budget) return toggle ? nonEmpty(toggleVariants(model)) : undefined
  return nonEmpty({ ...(toggle ? toggleVariants(model) : {}), ...budgetVariants(model, budget.min, budget.max) })
}

function anthropicVariants(model: ModelInput): VariantMap {
  const adaptiveEfforts = anthropicAdaptiveEfforts(model.apiId)
  if (adaptiveEfforts) {
    const omitted = anthropicOmitsThinking(model.apiId)
    return Object.fromEntries(
      adaptiveEfforts.map((effort) => [
        effort,
        {
          thinking: { type: 'adaptive', ...(omitted ? { display: 'summarized' } : {}) },
          effort,
        },
      ]),
    )
  }

  if (anthropicOpus45(model.apiId)) {
    return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { effort }]))
  }

  const output = model.limit.output || 32_000
  return {
    high: { thinking: { type: 'enabled', budgetTokens: Math.min(16_000, Math.floor(output / 2 - 1)) } },
    max: { thinking: { type: 'enabled', budgetTokens: Math.min(31_999, output - 1) } },
  }
}

function googleThinkingLevelEfforts(apiId: string) {
  const id = apiId.toLowerCase()
  // Gemma is on/off only: "minimal" turns it off and "high" turns it on.
  if (id.includes('gemma')) return ['minimal', 'high']
  if (!id.includes('gemini-3')) return ['low', 'high']
  if (id.includes('flash-image')) return ['minimal', 'high']
  if (id.includes('pro-image')) return ['high']
  if (id.includes('flash')) return ['minimal', 'low', 'medium', 'high']
  return ['low', 'medium', 'high']
}

function googleThinkingBudgetMax(apiId: string) {
  const id = apiId.toLowerCase()
  if (id.includes('2.5') && id.includes('pro') && !id.includes('flash')) return 32_768
  return 24_576
}

function googleVariants(model: ModelInput): VariantMap {
  const id = model.apiId.toLowerCase()
  // Gemini 2.5 controls it by token budget; Gemini 3+ by thinkingLevel.
  if (id.includes('2.5')) {
    return {
      high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16_000 } },
      max: { thinkingConfig: { includeThoughts: true, thinkingBudget: googleThinkingBudgetMax(id) } },
    }
  }
  return Object.fromEntries(
    googleThinkingLevelEfforts(id).map((effort) => [
      effort,
      { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } },
    ]),
  )
}

function openaiVariants(model: ModelInput): VariantMap {
  if (model.apiId.toLowerCase() === 'o1-mini') return {}
  const efforts = openaiReasoningEfforts(model.apiId, model.releaseDate)
  return Object.fromEntries(
    efforts.map((effort) => [
      effort,
      { reasoningEffort: effort, reasoningSummary: 'auto', include: INCLUDE_ENCRYPTED_REASONING },
    ]),
  )
}

function openAiCompatibleVariants(model: ModelInput): VariantMap {
  const id = model.apiId.toLowerCase()
  if (GPT5_FAMILY_RE.test(id) || id.includes('gpt')) {
    return Object.fromEntries(
      openaiCompatibleReasoningEfforts(model.apiId).map((effort) => [effort, { reasoningEffort: effort }]),
    )
  }
  const efforts = [...WIDELY_SUPPORTED_EFFORTS]
  if (id.includes('deepseek-v4')) efforts.push('max')
  return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
}

/**
 * Models that always think (or whose level is not controllable via the API) — the
 * thinking toggle stays locked and there is no variant picker. GLM-5.2 is out of the
 * rule: it is the first GLM with effort levels.
 */
export function isAlwaysOnModel(modelId: string, apiId: string): boolean {
  const id = modelId.toLowerCase()
  const api = apiId.toLowerCase()
  const has = (prefix: string) => id.includes(prefix) || api.includes(prefix)
  if (has('glm') && [id, api].some((value) => /glm-5[.p-]2/.test(value))) return false
  return [
    'deepseek-chat',
    'deepseek-reasoner',
    'deepseek-r1',
    'deepseek-v3',
    'minimax',
    'glm',
    'kimi',
    'k2p',
    'qwen',
    'big-pickle',
  ].some(has)
}

/**
 * Rules by model name, for when the catalog does not declare the levels.
 * The special cases come before the "always thinks" list: some of those
 * models do have a known control.
 */
function ruleVariants(model: ModelInput): VariantMap {
  const id = model.modelId.toLowerCase()
  const api = model.apiId.toLowerCase()

  // MiniMax M3: a real on/off. NVIDIA and Lilac serve it through a chat template.
  if (api.includes('minimax-m3') && ['@ai-sdk/anthropic', '@ai-sdk/openai-compatible'].includes(model.npm)) {
    if (['nvidia', 'lilac'].includes(model.providerId)) {
      return {
        none: { chat_template_kwargs: { thinking_mode: 'disabled' } },
        thinking: { chat_template_kwargs: { thinking_mode: 'enabled' } },
      }
    }
    return { none: { thinking: { type: 'disabled' } }, thinking: { thinking: { type: 'adaptive' } } }
  }

  if (isGlm52(model)) {
    // On OpenRouter, xhigh is GLM-5.2's native "max".
    if (model.npm === '@openrouter/ai-sdk-provider') {
      return { high: { reasoning: { effort: 'high' } }, xhigh: { reasoning: { effort: 'xhigh' } } }
    }
    if (model.npm === '@ai-sdk/openai-compatible') {
      return { high: { reasoningEffort: 'high' }, max: { reasoningEffort: 'max' } }
    }
    if (model.npm === '@ai-sdk/anthropic') return { high: { effort: 'high' }, max: { effort: 'max' } }
  }

  // Kimi through the transports compatible with Anthropic: adaptive effort.
  if (isKimiFamily(model) && isAnthropicSdk(model.npm)) {
    return Object.fromEntries(
      ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => [
        effort,
        { thinking: { type: 'adaptive', display: 'summarized' }, effort },
      ]),
    )
  }

  if (isAlwaysOnModel(model.modelId, model.apiId)) return {}

  // xAI: only grok-3-mini exposes effort control.
  // https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
  if (id.includes('grok')) {
    if (!id.includes('grok-3-mini')) return {}
    if (model.npm === '@openrouter/ai-sdk-provider') {
      return { low: { reasoning: { effort: 'low' } }, high: { reasoning: { effort: 'high' } } }
    }
    return { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } }
  }

  switch (model.npm) {
    case '@ai-sdk/anthropic':
    case '@ai-sdk/google-vertex/anthropic':
      return anthropicVariants(model)
    case '@ai-sdk/google':
    case '@ai-sdk/google-vertex':
      return googleVariants(model)
    case '@ai-sdk/openai':
    case '@ai-sdk/azure':
      return openaiVariants(model)
    case '@openrouter/ai-sdk-provider':
      return Object.fromEntries(
        (api.startsWith('openai/') || id.includes('gpt')
          ? openaiCompatibleReasoningEfforts(model.apiId)
          : WIDELY_SUPPORTED_EFFORTS
        ).map((effort) => [effort, { reasoning: { effort } }]),
      )
    default:
      // Providers with no dedicated SDK fall into the openai-compatible adapter.
      return openAiCompatibleVariants(model)
  }
}

/** Generates a model's variants map (id → providerOptions without namespace). */
export function generateVariants(model: ModelInput): VariantMap {
  if (!model.reasoning) return {}
  return catalogVariants(model) ?? ruleVariants(model)
}

const VARIANT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Very high',
  max: 'Max',
  thinking: 'On',
}

/** Display label for a variant id (fallback: capitalizes the id). */
export function variantLabel(id: string): string {
  return VARIANT_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1)
}
