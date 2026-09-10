import { app } from 'electron'
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
import { ProviderResolutionError } from './provider-errors'
import {
  SESSION_HEADER,
  SESSION_HEADER_PROVIDERS,
  freshSessionId,
  providerFetch,
} from './provider-fetch'
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
  fetch?: typeof fetch
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

/** Reexportado daqui porque era o endereço público da classe antes de o módulo
 *  existir (ver provider-errors.ts). */
export { ProviderResolutionError } from './provider-errors'

/**
 * Fallback para chamadas fora de qualquer conversa (ex: um teste de conexão do
 * provider nas Configurações). Enviar um id estável do processo é melhor que
 * omitir o header, que faria a requisição falhar.
 */
let processSessionId: string | null = null
function fallbackSessionId(): string {
  processSessionId ??= freshSessionId()
  return processSessionId
}

/**
 * Ids de sessão que o gateway já recusou, e o substituto que ele aceitou. Sem
 * isso, toda requisição seguinte do mesmo turno (tool loop, visão, workers)
 * repetiria a recusa e a repetição de emergência do `providerFetch` — dois
 * requests por passo, indefinidamente.
 */
const rejectedSessions = new Set<string>()
let recoveredSessionId: string | null = null

function rotateSession(rejectedId: string): string {
  rejectedSessions.add(rejectedId)
  recoveredSessionId ??= freshSessionId()
  return recoveredSessionId
}

/**
 * Id da conversa para o header de sessão (ver provider-fetch.ts). Id vazio é
 * tratado como ausente (o gateway faz o mesmo), daí `||` no lugar de `??`.
 */
function sessionIdFor(opts?: ResolveModelOptions): string {
  const base = opts?.sessionId || currentProviderSession() || fallbackSessionId()
  return rejectedSessions.has(base) ? (recoveredSessionId ??= freshSessionId()) : base
}

/**
 * UA do produto. O SDK assina sozinho (`ai-sdk/openai-compatible`) e o gateway
 * não tem como distinguir o Orbit de qualquer outro consumidor — a doc do
 * OpenCode Go pede que o cliente se identifique. Formato `Orbit/<versão>`.
 */
let cachedUserAgent: string | null = null
function orbitUserAgent(): string {
  if (cachedUserAgent === null) {
    let version = ''
    try {
      version = app?.getVersion?.() ?? ''
    } catch {
      // Fora do Electron (scripts, testes): assina com o nome puro.
    }
    cachedUserAgent = version ? `Orbit/${version}` : 'Orbit'
  }
  return cachedUserAgent
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
  if (!existing) headers[SESSION_HEADER] = sessionIdFor(opts)
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
    headers['user-agent'] = orbitUserAgent()
  }
  return headers
}

export async function resolveModel(
  providerId: string,
  modelId: string,
  opts?: ResolveModelOptions,
): Promise<LanguageModel> {
  const provider = await getProvider(providerId)
  if (!provider) {
    // Mensagens daqui são DIAGNÓSTICO (ficam em ChatMessage.error e aparecem
    // como detalhe cru no card) — a explicação que o usuário lê é traduzida na
    // UI a partir do `reason`/kind (chat.errorKind.*, notif.chatError.kind.*).
    throw new ProviderResolutionError(`Unknown provider: ${providerId}`, 'unknown-provider')
  }

  const npm = provider.npm ?? '@ai-sdk/openai-compatible'

  // SDKs que usam auth própria do ambiente (gcloud ADC, AWS credentials, etc.)
  if (npm === '@ai-sdk/google-vertex' || npm === '@ai-sdk/amazon-bedrock') {
    const factory = BUNDLED_SDKS[npm]
    if (!factory) throw new ProviderResolutionError(`Missing SDK: ${npm}`, 'missing-sdk')
    const sdk = (factory as () => ReturnType<typeof createVertex>)()
    return sdk(modelId)
  }

  const apiKey = await resolveApiKey(providerId, [...provider.env])
  if (!apiKey && provider.env.length > 0) {
    throw new ProviderResolutionError(
      `No API key configured for ${provider.name}. Add one in Settings.`,
      'missing-key',
    )
  }

  const factory = BUNDLED_SDKS[npm]
  const headers = providerHeaders(providerId, opts)
  // Nos provedores de sessão, o header também é garantido no transporte: o
  // wrapper repõe o que faltar em qualquer requisição do SDK e repete uma vez se
  // o gateway recusar a sessão (ver provider-fetch.ts).
  const fetchImpl = SESSION_HEADER_PROVIDERS.has(providerId)
    ? providerFetch(sessionIdFor(opts), rotateSession)
    : undefined

  if (factory && npm !== '@ai-sdk/openai-compatible') {
    const sdk = (factory as SdkFactory)({
      apiKey,
      ...(provider.api ? { baseURL: provider.api } : {}),
      ...(headers ? { headers } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })
    return sdk(modelId)
  }

  if (!provider.api) {
    throw new ProviderResolutionError(
      `Provider ${provider.name} requires the SDK ${npm}, which Orbit does not bundle yet.`,
      'missing-sdk',
    )
  }

  const sdk = createOpenAICompatible({
    name: provider.id,
    apiKey,
    baseURL: provider.api,
    includeUsage: true,
    ...(headers ? { headers } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
  return sdk(modelId)
}
