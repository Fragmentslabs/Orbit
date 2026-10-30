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
import { findCatalogModel } from '@shared/chat'
import { getProvider } from './catalog'
import { ProviderResolutionError } from './provider-errors'
import { modelRuntime } from './provider-npm'
import {
  SESSION_HEADER,
  SESSION_HEADER_PROVIDERS,
  freshSessionId,
  providerFetch,
} from './provider-fetch'
import { currentProviderSession } from './provider-session'

/**
 * Model resolution in the opencode style: the models.dev catalog tells
 * which npm package (`npm`) and base URL (`api`) each provider uses. The most
 * common SDKs are bundled; the rest fall back to the openai-compatible adapter.
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
 * Tells whether a provider's model is served by the openai-compatible adapter
 * in resolveModel — it mirrors the fallback rule exactly: SDKs without a bundled
 * package (npm outside BUNDLED_SDKS) and openai-compatible itself fall into
 * createOpenAICompatible. The reasoning module uses this to decide where to
 * inject interleaved fields (e.g. DeepSeek's reasoning_content) — the gate by the
 * catalog's npm name left out providers like OpenRouter
 * (npm: "@openrouter/ai-sdk-provider") even with the runtime serving through the
 * openai-compatible adapter.
 */
export function isServedByOpenAiCompatible(npm: string | undefined): boolean {
  if (npm == null || npm === '@ai-sdk/openai-compatible') return true
  return !(npm in BUNDLED_SDKS)
}

/** Re-exported from here because it was the class's public address before the module
 *  existed (see provider-errors.ts). */
export { ProviderResolutionError } from './provider-errors'

/**
 * Fallback for calls outside any conversation (e.g. a provider connection test in
 * Settings). Sending a stable process id is better than omitting the header, which
 * would make the request fail.
 */
let processSessionId: string | null = null
function fallbackSessionId(): string {
  processSessionId ??= freshSessionId()
  return processSessionId
}

/**
 * Session ids the gateway already refused, and the replacement it accepted. Without
 * this, every following request of the same turn (tool loop, vision, workers)
 * would repeat the refusal and the `providerFetch` emergency retry — two
 * requests per step, indefinitely.
 */
const rejectedSessions = new Set<string>()
let recoveredSessionId: string | null = null

function rotateSession(rejectedId: string): string {
  rejectedSessions.add(rejectedId)
  recoveredSessionId ??= freshSessionId()
  return recoveredSessionId
}

/**
 * Conversation id for the session header (see provider-fetch.ts). An empty id is
 * treated as absent (the gateway does the same), hence `||` instead of `??`.
 */
function sessionIdFor(opts?: ResolveModelOptions): string {
  const base = opts?.sessionId || currentProviderSession() || fallbackSessionId()
  return rejectedSessions.has(base) ? (recoveredSessionId ??= freshSessionId()) : base
}

/**
 * Product UA. The SDK signs on its own (`ai-sdk/openai-compatible`) and the gateway
 * has no way of telling Orbit from any other consumer — the OpenCode Go docs ask the
 * client to identify itself. Format `Orbit/<version>`.
 */
let cachedUserAgent: string | null = null
function orbitUserAgent(): string {
  if (cachedUserAgent === null) {
    let version = ''
    try {
      version = app?.getVersion?.() ?? ''
    } catch {
      // Outside Electron (scripts, tests): signs with the plain name.
    }
    cachedUserAgent = version ? `Orbit/${version}` : 'Orbit'
  }
  return cachedUserAgent
}

export interface ResolveModelOptions {
  /** Conversation id; if omitted, it uses the scope opened by `withProviderSession`. */
  sessionId?: string
  /** Headers already defined for the request — preserved as they are. */
  headers?: Record<string, string>
}

/**
 * Assembles the provider's extra headers. If the session header is already defined
 * (in any capitalization), it is reused instead of overwritten.
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
    // Messages from here are DIAGNOSTIC (they stay in ChatMessage.error and show up
    // as raw detail in the card) — the explanation the user reads is translated in the
    // UI from `reason`/kind (chat.errorKind.*, notif.chatError.kind.*).
    throw new ProviderResolutionError(`Unknown provider: ${providerId}`, 'unknown-provider')
  }
  // Id renamed in models.dev: it asks the provider for the successor, not the old name
  // (which the gateway sometimes still accepts, but with another behavior).
  const found = findCatalogModel({ [provider.id]: provider }, provider.id, modelId)
  modelId = found?.modelId ?? modelId

  // The SDK and the endpoint belong to the MODEL when the catalog declares them (see
  // modelRuntime); otherwise the provider's. A custom provider has no `npm`
  // in the catalog: whoever decides the SDK is the protocol` of the registration.
  const { npm, api } = modelRuntime(provider, found?.model)

  // SDKs that use their own auth from the environment (gcloud ADC, AWS credentials, etc.)
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
  // In session providers, the header is also guaranteed in the transport: the
  // wrapper puts back whatever is missing in any SDK request and retries once if
  // the gateway refuses the session (see provider-fetch.ts).
  const fetchImpl = SESSION_HEADER_PROVIDERS.has(providerId)
    ? providerFetch(sessionIdFor(opts), rotateSession)
    : undefined

  // Explicit protocol of a provider outside models.dev: the gateway speaks
  // Anthropic Messages or the /responses endpoint, and the openai-compatible
  // adapter does not serve either of them.
  if (provider.protocol === 'anthropic-messages') {
    const sdk = createAnthropic({
      apiKey,
      ...(provider.api ? { baseURL: provider.api } : {}),
      ...(headers ? { headers } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })
    return sdk(modelId)
  }

  if (provider.protocol === 'openai-responses') {
    const sdk = createOpenAI({
      apiKey,
      ...(provider.api ? { baseURL: provider.api } : {}),
      ...(headers ? { headers } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })
    return sdk.responses(modelId)
  }

  if (factory && npm !== '@ai-sdk/openai-compatible') {
    const sdk = (factory as SdkFactory)({
      apiKey,
      ...(api ? { baseURL: api } : {}),
      ...(headers ? { headers } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })
    return sdk(modelId)
  }

  if (!api) {
    throw new ProviderResolutionError(
      `Provider ${provider.name} requires the SDK ${npm}, which Orbit does not bundle yet.`,
      'missing-sdk',
    )
  }

  const sdk = createOpenAICompatible({
    name: provider.id,
    apiKey,
    baseURL: api,
    includeUsage: true,
    ...(headers ? { headers } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(provider.compat?.maxTokensField === 'max_completion_tokens'
      ? { transformRequestBody: renameMaxTokensField }
      : {}),
  })
  return sdk(modelId)
}

/**
 * Gateways that only accept `max_completion_tokens` (o-series family models
 * behind a proxy). The openai-compatible adapter always sends `max_tokens`;
 * here the field is renamed without touching the rest of the body.
 */
function renameMaxTokensField(body: Record<string, unknown>): Record<string, unknown> {
  if (!('max_tokens' in body)) return body
  const { max_tokens, ...rest } = body
  return { ...rest, max_completion_tokens: max_tokens }
}
