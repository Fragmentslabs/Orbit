import type { JSONValue, ModelMessage, ToolContent } from 'ai'
import type { CatalogProvider, SendMessageInput } from '@shared/chat'
import { closestVariant, findCatalogModel } from '@shared/chat'
import { getProvider } from '../catalog'
import { isServedByOpenAiCompatible } from '../providers'
import { modelRuntime } from '../provider-npm'
import { mergeOptions } from './merge'
import { buildBaseOptions } from './options'
import { generateVariants, toModelInput } from './variants'

export { buildBaseOptions } from './options'
export { buildSmallOptions } from './small-options'
export type { ModelInput, VariantMap, VariantPayload } from './types'
export { generateVariants, isAlwaysOnModel, toModelInput, variantLabel } from './variants'

/**
 * providerOptions namespace read by each bundled SDK. Providers that
 * fall into the openai-compatible adapter use the camelCase of the provider id as the
 * namespace (createOpenAICompatible({ name: provider.id }) in providers.ts) —
 * the raw form (e.g. "my-gateway") is still accepted by the SDK, but emits a
 * DeprecationWarning. The rule is the same as the adapter's to-camel-case.ts.
 */
const SDK_NAMESPACES: Record<string, string> = {
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google': 'google',
  '@ai-sdk/openai': 'openai',
}

/** Mirrors @ai-sdk/openai-compatible's toCamelCase: "-x"/"_x" → "X". */
const toCamelCase = (s: string): string => s.replace(/[_-]([a-z])/g, (g) => g[1].toUpperCase())

/**
 * Builds the request's providerOptions from the reasoning
 * configuration: provider baseline → payload of the selected variant → wrap in the
 * SDK namespace. Returns undefined when thinking is off or the
 * model does not support reasoning.
 */
export async function buildProviderOptions(
  input: SendMessageInput,
): Promise<Record<string, Record<string, JSONValue>> | undefined> {
  const reasoning = input.options.reasoning
  if (!reasoning?.enabled) return undefined

  const provider = await getProvider(input.providerId)
  // Follows the models.dev rename: with the old id saved, the model "vanished"
  // from here and the turn went out with no reasoning at all, even with the level on in the UI.
  const found = provider && findCatalogModel({ [provider.id]: provider }, provider.id, input.modelId)
  if (!provider || !found) {
    console.warn('[reasoning] model outside the catalog — turn without reasoning', input.providerId, input.modelId)
    return undefined
  }
  const model = found.model
  if (!model.reasoning) return undefined

  const runtime = modelRuntime(provider, model)
  const modelInput = toModelInput(input.providerId, runtime.npm, model, runtime.api)
  const variants = generateVariants(modelInput)

  // A saved level the model does not have becomes the nearest neighbor; with no level
  // chosen, only the baseline remains.
  const variantId = closestVariant(Object.keys(variants), reasoning.variantId)
  const variantPayload = variantId ? variants[variantId] : {}

  const base = buildBaseOptions(modelInput, input.sessionId)
  const merged = mergeOptions(base, variantPayload)
  if (Object.keys(merged).length === 0) return undefined

  const namespace = SDK_NAMESPACES[modelInput.npm] ?? toCamelCase(input.providerId)
  return { [namespace]: merged as Record<string, JSONValue> }
}

/** From the cheapest to the most expensive: the first one the model has. */
const CHEAPEST_VARIANTS = ['none', 'minimal', 'low']

/**
 * providerOptions with the LOWEST reasoning the model accepts — for loops of
 * many short steps (the Computer Use subagent), where each step is "click
 * the button I just saw" and the provider default reasoning is cost and
 * waiting with no gain. undefined when the model does not reason or has no low
 * level (then the provider default applies).
 */
export async function buildCheapestReasoningOptions(
  providerId: string,
  modelId: string,
  sessionId: string,
): Promise<Record<string, Record<string, JSONValue>> | undefined> {
  const provider = await getProvider(providerId)
  const found = provider && findCatalogModel({ [provider.id]: provider }, provider.id, modelId)
  if (!provider || !found?.model.reasoning) return undefined
  const runtime = modelRuntime(provider, found.model)
  const modelInput = toModelInput(providerId, runtime.npm, found.model, runtime.api)
  const variants = generateVariants(modelInput)
  const variantId = CHEAPEST_VARIANTS.find((id) => id in variants)
  if (!variantId) return undefined
  const merged = mergeOptions(buildBaseOptions(modelInput, sessionId), variants[variantId])
  if (Object.keys(merged).length === 0) return undefined
  const namespace = SDK_NAMESPACES[modelInput.npm] ?? toCamelCase(providerId)
  return { [namespace]: merged as Record<string, JSONValue> }
}

/**
 * Field used to resend the reasoning in the assistant message. DeepSeek models served
 * by the openai-compatible adapter use `reasoning_content`; DeepSeek requires
 * the field in ALL assistant messages in subsequent turns, even
 * when empty (otherwise the API returns 400). The gate uses the runtime's real
 * resolution rule (isServedByOpenAiCompatible), not just the catalog npm — otherwise
 * providers like OpenRouter (npm "@openrouter/ai-sdk-provider", served via
 * createOpenAICompatible in resolveModel) would be left out.
 */
export function interleavedReasoningField(
  provider: CatalogProvider | undefined,
  modelId: string,
): string | undefined {
  // Explicit setting of the custom provider: a gateway may serve a
  // DeepSeek model whose name does not contain "deepseek" (ds-v3), or serve a
  // model from another vendor that also requires the field.
  const format = provider?.compat?.thinkingFormat
  if (format === 'none') return undefined

  const model = provider && findCatalogModel({ [provider.id]: provider }, provider.id, modelId)?.model
  const servedByOpenAiCompatible = isServedByOpenAiCompatible(modelRuntime(provider, model).npm)
  // `reasoning_content` is a field of the openai-compatible dialect (and
  // normalizeMessages rewrites providerOptions.openaiCompatible): in an
  // Anthropic/Responses protocol the field does not exist.
  if (!servedByOpenAiCompatible) return undefined

  if (format === 'deepseek' || modelId.toLowerCase().includes('deepseek')) {
    return 'reasoning_content'
  }
  return undefined
}

/**
 * Guarantees that the content of tool messages never breaks the openai-compatible
 * adapter's converter: it reads `output.type` from every part that is not
 * `tool-approval-response` (openai-compatible/dist/internal/index.js, case
 * "tool") and throws `TypeError: Cannot read properties of undefined (reading
 * 'type')` when `output` is missing — edge cases of the SDK's tool loop can
 * produce parts like that. Parts without a valid output become a `tool-result` with
 * neutral text output; content that is not an array (e.g. a string, which the
 * converter's `for...of` would iterate character by character) is normalized to an array; and
 * null/undefined becomes `[]` (the SDK drops empty tool messages). Returns
 * the same reference when nothing changes.
 */
function sanitizeToolContent(content: ToolContent): ToolContent {
  if (content == null) return []
  if (!Array.isArray(content)) {
    const text = String(content)
    if (text.length === 0) return []
    return [
      {
        type: 'tool-result',
        toolCallId: '',
        toolName: '',
        output: { type: 'text', value: text },
      },
    ]
  }
  let changed = false
  const parts = content.map((part) => {
    if (part != null && typeof part === 'object') {
      if (part.type === 'tool-approval-response') return part
      if (part.type === 'tool-result' && part.output && typeof part.output.type === 'string') {
        return part
      }
    }
    changed = true
    const raw = part as { toolCallId?: unknown; toolName?: unknown }
    return {
      type: 'tool-result' as const,
      toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : '',
      toolName: typeof raw.toolName === 'string' ? raw.toolName : '',
      output: {
        type: 'text' as const,
        value:
          typeof part === 'string' || typeof part === 'number' || typeof part === 'boolean'
            ? String(part)
            : '[result unavailable]',
      },
    }
  })
  return changed ? parts : content
}

/**
 * Moves the reasoning of assistant messages into the SDK's providerOptions.
 * Always sets
 * the field, even empty: providers like DeepSeek require the reasoning_content
 * back in every assistant message in subsequent turns, and the
 * @ai-sdk/openai-compatible converter would drop an empty value coming from the
 * parts (it only emits `reasoning_content` when `reasoning.length > 0`).
 *
 * It also always runs (regardless of the reasoning field) the sanitization of
 * tool messages via sanitizeToolContent — it protects the converter from malformed
 * parts produced by edge cases of the SDK's tool loop.
 *
 * It is idempotent: if the message has no reasoning parts (because it was already
 * normalized before, e.g. prepareStep), it preserves the value already present in
 * providerOptions instead of overwriting it with empty. Returns the same reference
 * when nothing changes (so prepareStep returns `{}` and the SDK skips the rewrite).
 */
export function normalizeMessages(msgs: ModelMessage[], field?: string): ModelMessage[] {
  let changed = false
  const result = msgs.map((msg): ModelMessage => {
    if (msg.role === 'tool') {
      const content = sanitizeToolContent(msg.content)
      if (content !== msg.content) changed = true
      return content === msg.content ? msg : { ...msg, content }
    }
    if (msg.role !== 'assistant' || !field || !Array.isArray(msg.content)) return msg
    changed = true
    const reasoningParts = msg.content.filter(
      (part): part is Extract<ModelMessage, { role: 'assistant' }>['content'][number] & {
        type: 'reasoning'
        text: string
      } => part.type === 'reasoning',
    )
    const existing = msg.providerOptions?.openaiCompatible as Record<string, JSONValue> | undefined
    const reasoningContent =
      reasoningParts.length > 0
        ? reasoningParts.map((part) => part.text).join('')
        : ((existing?.[field] as string | undefined) ?? '')
    const filteredContent = msg.content.filter((part) => part.type !== 'reasoning')
    return {
      ...msg,
      content: filteredContent,
      providerOptions: {
        ...msg.providerOptions,
        openaiCompatible: {
          ...existing,
          [field]: reasoningContent,
        },
      },
    }
  })
  return changed ? result : msgs
}
