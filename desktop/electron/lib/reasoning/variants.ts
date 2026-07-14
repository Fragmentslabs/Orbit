import type { CatalogModel } from '../../../shared/chat'
import type { ModelInput, VariantMap } from './types'

/** Converte um modelo do catálogo models.dev no input interno do módulo. */
export function toModelInput(providerId: string, npm: string | undefined, model: CatalogModel): ModelInput {
  return {
    providerId,
    modelId: model.id,
    npm: npm ?? '@ai-sdk/openai-compatible',
    apiId: model.id,
    releaseDate: model.release_date ?? '',
    reasoning: model.reasoning,
    limit: model.limit ?? { context: 0, output: 0 },
  }
}

/**
 * Geração de níveis de reasoning (variants) por provedor, portada do
 * opencode (provider/transform.ts → variants()) e reestruturada em funções
 * por provider em vez de um switch monolítico. Cobre os SDKs empacotados no
 * Orbit: anthropic, google, openai e openai-compatible (fallback).
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

// A OpenAI lançou o tier `none` de reasoning_effort nesta data (Responses API).
// Modelos anteriores retornam 400 com `reasoning_effort: "none"`, então só
// expomos o tier para modelos novos o suficiente.
const OPENAI_NONE_EFFORT_RELEASE_DATE = '2025-11-13'

// Mesma lógica para o tier `xhigh`.
const OPENAI_XHIGH_EFFORT_RELEASE_DATE = '2025-12-04'

// Necessário para reasoning multi-turno stateless (store: false).
const INCLUDE_ENCRYPTED_REASONING = ['reasoning.encrypted_content']

// Casa membros da família gpt-5 nos formatos de id encontrados:
//   "gpt-5", "gpt-5-nano", "gpt-5.4", "openai/gpt-5.4-codex".
// Ancorado em início-de-string ou "/" para não casar "gpt-50" ou "gpt-5o".
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

// Tiers de reasoning_effort que um modelo OpenAI expõe, do mais fraco ao mais forte.
function openaiReasoningEfforts(apiId: string, releaseDate: string) {
  const id = apiId.toLowerCase()
  if (id.includes('deep-research')) return ['medium']
  const chatEfforts = gpt5ChatReasoningEfforts(id)
  if (chatEfforts) return chatEfforts
  if (GPT5_PRO_RE.test(id)) return OPENAI_GPT5_PRO_EFFORTS
  const codexEfforts = gpt5CodexReasoningEfforts(id)
  if (codexEfforts) return codexEfforts
  // GPT-5.1 trocou o `minimal` do GPT-5 por `none`; GPT-5.2+ aceita `xhigh`.
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
  // Casa "opus-4.7" (Anthropic/Bedrock/Vertex) e "claude-4.7-opus" (invertido).
  // Versões limitadas a 1-2 dígitos para não confundir sufixos de data
  // ("claude-opus-4-20250514") com número de versão.
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

// Modelos adaptive mais novos usam display "omitted" por padrão, retornando
// blocos de thinking vazios — forçamos "summarized" para preservar resumos.
function anthropicOmitsThinking(apiId: string) {
  return anthropicOpus47OrLater(apiId) || anthropicSonnet5OrLater(apiId) || apiId.includes('fable-5')
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

  if (['opus-4-5', 'opus-4.5'].some((v) => model.apiId.includes(v))) {
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
  // Gemini 2.5 controla por budget de tokens; Gemini 3+ por thinkingLevel.
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
 * Modelos que sempre pensam (ou cujo nível não é controlável via API) — o
 * toggle de thinking fica travado e não há variant picker.
 */
export function isAlwaysOnModel(modelId: string, apiId: string): boolean {
  const id = modelId.toLowerCase()
  const api = apiId.toLowerCase()
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
  ].some((prefix) => id.includes(prefix) || api.includes(prefix))
}

/** Gera o mapa de variants (id → providerOptions sem namespace) de um modelo. */
export function generateVariants(model: ModelInput): VariantMap {
  if (!model.reasoning) return {}

  const id = model.modelId.toLowerCase()
  if (isAlwaysOnModel(model.modelId, model.apiId)) return {}

  // xAI: só o grok-3-mini expõe controle de esforço.
  // https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
  if (id.includes('grok')) {
    if (id.includes('grok-3-mini')) {
      return { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } }
    }
    return {}
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
    default:
      // Provedores sem SDK dedicado caem no adaptador openai-compatible.
      return openAiCompatibleVariants(model)
  }
}

const VARIANT_LABELS: Record<string, string> = {
  none: 'Nenhum',
  minimal: 'Mínimo',
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Muito alto',
  max: 'Máximo',
}

/** Label de exibição para um id de variant (fallback: capitaliza o id). */
export function variantLabel(id: string): string {
  return VARIANT_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1)
}
