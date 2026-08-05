import type { JSONValue, ModelMessage } from 'ai'
import type { CatalogProvider, SendMessageInput } from '@shared/chat'
import { getProvider } from '../catalog'
import { isServedByOpenAiCompatible } from '../providers'
import { mergeOptions } from './merge'
import { buildBaseOptions } from './options'
import { generateVariants, toModelInput } from './variants'

export { buildBaseOptions } from './options'
export { buildSmallOptions } from './small-options'
export type { ModelInput, VariantMap, VariantPayload } from './types'
export { generateVariants, isAlwaysOnModel, toModelInput, variantLabel } from './variants'

/**
 * Namespace de providerOptions lido por cada SDK empacotado. Provedores que
 * caem no adaptador openai-compatible usam o id do provedor como namespace
 * (createOpenAICompatible({ name: provider.id }) em providers.ts).
 */
const SDK_NAMESPACES: Record<string, string> = {
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google': 'google',
  '@ai-sdk/openai': 'openai',
}

/**
 * Constrói o providerOptions da requisição a partir da configuração de
 * reasoning: baseline do provedor → payload da variant selecionada → wrap no
 * namespace do SDK. Retorna undefined quando thinking está desligado ou o
 * modelo não suporta reasoning.
 */
export async function buildProviderOptions(
  input: SendMessageInput,
): Promise<Record<string, Record<string, JSONValue>> | undefined> {
  const reasoning = input.options.reasoning
  if (!reasoning?.enabled) return undefined

  const provider = await getProvider(input.providerId)
  const model = provider?.models[input.modelId]
  if (!provider || !model?.reasoning) return undefined

  const modelInput = toModelInput(input.providerId, provider.npm, model)
  const variants = generateVariants(modelInput)

  // Variant desconhecida ou não selecionada: usa apenas o baseline.
  const variantPayload =
    reasoning.variantId && variants[reasoning.variantId] ? variants[reasoning.variantId] : {}

  const base = buildBaseOptions(modelInput, input.sessionId)
  const merged = mergeOptions(base, variantPayload)
  if (Object.keys(merged).length === 0) return undefined

  const namespace = SDK_NAMESPACES[modelInput.npm] ?? input.providerId
  return { [namespace]: merged as Record<string, JSONValue> }
}

/**
 * Campo usado para reenviar o raciocínio na mensagem do assistente — portado
 * do opencode (provider.ts → interleaved default). Modelos DeepSeek servidos
 * pelo adaptador openai-compatible usam `reasoning_content`; o DeepSeek exige
 * o campo em TODAS as mensagens de assistente em turnos seguintes, mesmo
 * quando vazio (senão a API retorna 400). O gate usa a regra de resolução real
 * do runtime (isServedByOpenAiCompatible), não só o npm do catálogo — senão
 * provedores como OpenRouter (npm "@openrouter/ai-sdk-provider", servido via
 * createOpenAICompatible no resolveModel) ficariam de fora.
 */
export function interleavedReasoningField(
  provider: CatalogProvider | undefined,
  modelId: string,
): string | undefined {
  if (isServedByOpenAiCompatible(provider?.npm) && modelId.toLowerCase().includes('deepseek')) {
    return 'reasoning_content'
  }
  return undefined
}

/**
 * Move o raciocínio das mensagens de assistente para o providerOptions do
 * SDK — portado do opencode (transform.ts → normalizeMessages). Sempre define
 * o campo, mesmo vazio: provedores como o DeepSeek exigem o reasoning_content
 * de volta em todas as mensagens de assistente em turnos subsequentes, e o
 * conversor do @ai-sdk/openai-compatible descartaria um valor vazio vindo dos
 * parts (ele só emite `reasoning_content` quando `reasoning.length > 0`).
 *
 * É idempotente: se a mensagem não tem parts de reasoning (porque já foi
 * normalizada antes, ex: prepareStep), preserva o valor já presente no
 * providerOptions em vez de sobrescrever com vazio.
 */
export function normalizeMessages(msgs: ModelMessage[], field?: string): ModelMessage[] {
  if (!field) return msgs
  return msgs.map((msg): ModelMessage => {
    if (msg.role !== 'assistant') return msg
    if (!Array.isArray(msg.content)) return msg
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
}
