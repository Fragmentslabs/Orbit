import type { JSONValue } from 'ai'
import type { SendMessageInput } from '../../../shared/chat'
import { getProvider } from '../catalog'
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
