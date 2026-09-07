import { randomUUID } from 'node:crypto'
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
import { currentProviderSession } from './provider-session'

/**
 * Resolução de modelos no padrão do opencode: o catálogo models.dev informa
 * qual pacote npm (`npm`) e URL base (`api`) cada provedor usa. Os SDKs mais
 * comuns são empacotados; os demais caem no adaptador openai-compatible.
 */

type SdkFactory = (opts: {
  apiKey?: string
  baseURL?: string
  headers?: Record<string, string>
}) => {
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

/**
 * Indica se o modelo de um provider é servido pelo adaptador openai-compatible
 * no resolveModel — espelha exatamente a regra de fallback: SDKs sem pacote
 * empacotado (npm fora de BUNDLED_SDKS) e o próprio openai-compatible caem em
 * createOpenAICompatible. O módulo de reasoning usa isso para decidir onde
 * injetar campos interleaved (ex: reasoning_content do DeepSeek) — o gate pelo
 * nome do npm do catálogo deixava de fora providers como o OpenRouter
 * (npm: "@openrouter/ai-sdk-provider") mesmo com o runtime servindo via
 * adaptador openai-compatible.
 */
export function isServedByOpenAiCompatible(npm: string | undefined): boolean {
  if (npm == null || npm === '@ai-sdk/openai-compatible') return true
  return !(npm in BUNDLED_SDKS)
}

export class ProviderResolutionError extends Error {}

/**
 * Header de sessão exigido pelo OpenCode (Zen e Go): sem ele a API responde
 * "Request is missing x-opencode-session and cannot be routed efficiently".
 * O valor é o id da conversa — estável durante toda ela e novo a cada conversa
 * criada. Só é aplicado aos providers listados aqui; os demais seguem sem
 * headers extras.
 */
const SESSION_HEADER = 'x-opencode-session'
const SESSION_HEADER_PROVIDERS = new Set(['opencode', 'opencode-go'])

/**
 * Fallback para chamadas fora de qualquer conversa (ex: um teste de conexão do
 * provider nas Configurações). Enviar um id estável do processo é melhor que
 * omitir o header, que faria a requisição falhar.
 */
let processSessionId: string | null = null
function fallbackSessionId(): string {
  processSessionId ??= `orbit_${randomUUID()}`
  return processSessionId
}

export interface ResolveModelOptions {
  /** Id da conversa; se omitido, usa o escopo aberto por `withProviderSession`. */
  sessionId?: string
  /** Headers já definidos para a requisição — preservados como estão. */
  headers?: Record<string, string>
}

/**
 * Monta os headers extras do provider. Se o header de sessão já vier definido
 * (em qualquer capitalização), é reaproveitado em vez de sobrescrito.
 */
function providerHeaders(
  providerId: string,
  opts?: ResolveModelOptions,
): Record<string, string> | undefined {
  const headers = { ...(opts?.headers ?? {}) }
  if (!SESSION_HEADER_PROVIDERS.has(providerId)) {
    return Object.keys(headers).length > 0 ? headers : undefined
  }
  const existing = Object.keys(headers).find((k) => k.toLowerCase() === SESSION_HEADER)
  if (!existing) {
    headers[SESSION_HEADER] = opts?.sessionId ?? currentProviderSession() ?? fallbackSessionId()
  }
  return headers
}

export async function resolveModel(
  providerId: string,
  modelId: string,
  opts?: ResolveModelOptions,
): Promise<LanguageModel> {
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
  if (!apiKey && provider.env.length > 0) {
    throw new ProviderResolutionError(
      `Nenhuma chave de API configurada para ${provider.name}. Adicione uma em Configurações.`,
    )
  }

  const factory = BUNDLED_SDKS[npm]
  const headers = providerHeaders(providerId, opts)

  if (factory && npm !== '@ai-sdk/openai-compatible') {
    const sdk = (factory as SdkFactory)({
      apiKey,
      ...(provider.api ? { baseURL: provider.api } : {}),
      ...(headers ? { headers } : {}),
    })
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
    ...(headers ? { headers } : {}),
  })
  return sdk(modelId)
}
