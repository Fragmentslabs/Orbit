import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createVertex } from '@ai-sdk/google-vertex'
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { createAzure } from '@ai-sdk/azure'
import { createCohere } from '@ai-sdk/cohere'
import type { LanguageModel } from 'ai'
import { resolveApiKey } from './auth'
import { getProvider } from './catalog'

/**
 * Resolução de modelos no padrão do opencode: o catálogo models.dev informa
 * qual pacote npm (`npm`) e URL base (`api`) cada provedor usa. Os SDKs mais
 * comuns são empacotados; os demais caem no adaptador openai-compatible.
 */

type SdkFactory = (opts: { apiKey?: string; baseURL?: string }) => {
  languageModel?: (id: string) => LanguageModel
  (id: string): LanguageModel
}

const BUNDLED_SDKS: Record<string, unknown> = {
  '@ai-sdk/anthropic': createAnthropic,
  '@ai-sdk/openai': createOpenAI,
  '@ai-sdk/google': createGoogleGenerativeAI,
  '@ai-sdk/google-vertex': createVertex,
  '@ai-sdk/amazon-bedrock': createAmazonBedrock,
  '@ai-sdk/azure': createAzure,
  '@ai-sdk/cohere': createCohere,
  '@ai-sdk/openai-compatible': createOpenAICompatible,
}

export class ProviderResolutionError extends Error {}

export async function resolveModel(providerId: string, modelId: string): Promise<LanguageModel> {
  const provider = await getProvider(providerId)
  if (!provider) throw new ProviderResolutionError(`Provedor desconhecido: ${providerId}`)

  const npm = provider.npm ?? '@ai-sdk/openai-compatible'

  // SDKs que usam auth própria do ambiente (gcloud ADC, AWS credentials, etc.)
  if (npm === '@ai-sdk/google-vertex' || npm === '@ai-sdk/amazon-bedrock') {
    const factory = BUNDLED_SDKS[npm]
    if (!factory) throw new ProviderResolutionError(`SDK não encontrado: ${npm}`)
    const sdk = (factory as () => ReturnType<typeof createVertex>)()
    return sdk(modelId)
  }

  const apiKey = await resolveApiKey(providerId, [...provider.env])
  if (!apiKey) {
    throw new ProviderResolutionError(
      `Nenhuma chave de API configurada para ${provider.name}. Adicione uma em Configurações.`,
    )
  }

  const factory = BUNDLED_SDKS[npm]

  if (factory && npm !== '@ai-sdk/openai-compatible') {
    const sdk = (factory as SdkFactory)({ apiKey, ...(provider.api ? { baseURL: provider.api } : {}) })
    return sdk(modelId)
  }

  if (!provider.api) {
    throw new ProviderResolutionError(
      `O provedor ${provider.name} requer o SDK ${npm}, que não está disponível no Orbit ainda.`,
    )
  }

  const sdk = createOpenAICompatible({
    name: provider.id,
    apiKey,
    baseURL: provider.api,
    includeUsage: true,
  })
  return sdk(modelId)
}
