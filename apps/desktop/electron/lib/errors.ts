import type { MessageErrorKind } from '@shared/chat'
import { ProviderResolutionError } from './provider-errors'

/**
 * Converts a thrown value into readable text. The AI SDK and the gateways
 * (OpenRouter, NVIDIA, etc.) sometimes throw nested objects that are not
 * Error instances — without this handling, `String(obj)` would render
 * "[object Object]" in the error card.
 *
 * It never throws: it runs inside catch blocks, and an exception here would take down the
 * error handling itself (the session would stay without status and without a message).
 */
export function errorToText(value: unknown, depth = 0): string {
  try {
    if (value instanceof Error) return value.message
    if (typeof value === 'string') return value
    if (typeof value === 'object' && value !== null) {
      // Guard against cyclic `{error:{error:{...}}}` chains
      if (depth > 10) return '[error nested too deep]'
      const obj = value as { error?: unknown; message?: unknown }
      const inner = obj.error ?? obj.message
      if (inner != null && inner !== value) return errorToText(inner, depth + 1)
      return JSON.stringify(value, null, 2)
    }
    return String(value)
  } catch {
    return '[error not serializable]'
  }
}

/**
 * Provider content moderation. The block happens on the provider's server,
 * before the answer gets here — there is no flag in the request that
 * turns it off, so the only path is switching models.
 *
 * Alibaba/DashScope (Qwen, also served by gateways like OpenCode Zen) is
 * by far the most common case: the inspection runs over the model's OUTPUT and gives
 * false positives frequently when there is an image in the context (screenshots of UI with
 * a lot of text are a known trigger).
 */
const MODERATION_PATTERNS = [
  /data_inspection_failed/i,
  /datainspectionfailed/i,
  /inappropriate content/i,
  /content_filter/i,
  /content_policy_violation/i,
  /responsible_ai_policy/i,
  /\bguardrail/i,
  /blocked by (the )?safety/i,
  /PROHIBITED_CONTENT/,
  /SAFETY_?BLOCK/i,
]

/** Model nonexistent/unavailable at the provider — switching models solves it. */
const MODEL_UNAVAILABLE_PATTERNS = [
  /\bis not supported\b/i,
  /model_not_found/i,
  /\bunknown model\b/i,
  /no endpoints found/i,
  /\bmodel .* does not exist/i,
]

/**
 * Refusal by the OpenCode gateway for lack of the session header. The request did not
 * even get routed and no token was consumed — it is unavailability of the
 * path to the model, not of the request: it falls into `network` (recoverable) so that
 * the model rotation moves on. `providerFetch` already retries once with a
 * new session id before this, so getting here means that the retry
 * failed too.
 */
const SESSION_ROUTING_PATTERNS = [/missing x-opencode-session/i]

/**
 * Context overflow: the request was assembled larger than the model's window.
 * It is NOT rotatable — switching models sends the same giant payload to
 * another endpoint and fails the same (if not worse, on a model with a smaller window).
 * What solves it is shrinking what goes in the request: compacting the conversation or
 * starting another one.
 *
 * Before this kind existed, these failures fell into `rate-limit` (see
 * `matchable`) and the UI asked to "wait a bit or switch models" —
 * advice that was never going to work, and the rotation still burned the whole
 * sequence of models repeating the same request.
 */
const CONTEXT_LENGTH_PATTERNS = [
  /context_length_exceeded/i,
  /maximum context length/i,
  /context length exceeded/i,
  /prompt is too long/i,
  /reduce the length of the (messages|prompt|input)/i,
  /exceeds? the (maximum )?(number of )?(input )?tokens/i,
  /token count .{0,40}exceeds/i,
  /input length and .?max_tokens.? exceed context limit/i,
  /context window (is )?(full|exceeded)/i,
  /too many (input )?tokens/i,
]

/**
 * Too many TOOLS in the request. Groq refuses above 128 and takes the whole call
 * down; the message usually contains the word "limit" and would fall into rate-limit,
 * which is rotatable and tells you to switch models — wrong advice, because the ceiling
 * is the endpoint's. It has to come BEFORE rate-limit.
 */
const TOOL_LIMIT_PATTERNS = [
  /too many tools/i,
  /maximum (of )?\d+ tools/i,
  /tools? .{0,40}(must|can|cannot).{0,30}(at most|no more than|exceed) \d+/i,
  /number of tools? .{0,30}(exceed|limit)/i,
  /tools? (count|length) .{0,30}(exceed|limit)/i,
]

/**
 * Usage/request limit of the provider or gateway. It covers the classic 429
 * (OpenAI/Anthropic/OpenRouter: `statusCode`/`code` 429), OpenCode's Zen
 * (`FreeUsageLimitError` — free usage ceiling per account, rolling window) and
 * quota messages from the other gateways (Groq, orama, NVIDIA...).
 */
const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /too many requests/i,
  /rate[ _-]?limit/i,
  /rate.?limited/i,
  /freeusage/i,
  /free ?usage ?limit/i,
  /quota (exceeded|exhausted|reached)/i,
  // OpenAI's quota 429 inverts the order ("You exceeded your current
  // quota") and the code comes as insufficient_quota — neither matched
  // the pattern above, which requires the verb right after "quota".
  /insufficient_quota/i,
  /(exceed|exhaust)\w*\s+(your\s+)?(current\s+)?quota/i,
  /usage limit/i,
  /request limit/i,
  /RATE_LIMIT_EXCEEDED|RATE_LIMITED/i,
  /retry.?after/i,
]

/**
 * Network/endpoint unavailability. It covers native undici/fetch codes
 * (`ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_CONNECT_TIMEOUT`...), the Vercel SDK's
 * `fetch failed`, and HTTP 5xx (OpenAI `server_error`, Anthropic
 * `overloaded_error` on 529, gateways on 502/503/504).
 */
const NETWORK_PATTERNS = [
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /ETIMEDOUT/i,
  /EHOSTUNREACH/i,
  /EAI_AGAIN/i,
  /EPIPE/i,
  /EADDRNOTAVAIL/i,
  /UND_ERR_CONNECT_TIMEOUT/i,
  /UND_ERR_SOCKET/i,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
  /connection (refused|reset|closed|timed out)/i,
  /timed? ?out/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /overloaded/i,
  /\b5\d{2}\b/, // HTTP 5xx
]

/**
 * Provider configuration error, even when re-wrapped. Instances from distinct modules
 * (duplicated bundle) escape `instanceof`, so `name` — fixed
 * in the constructor — is the second criterion.
 */
function isProviderConfigError(value: unknown): boolean {
  return (
    value instanceof ProviderResolutionError ||
    (value instanceof Error && value.name === 'ProviderResolutionError')
  )
}

export interface ClassifiedError {
  kind: MessageErrorKind
  /** Provider's raw text, preserved for diagnosis in the error card. */
  detail: string
}

/**
 * Text used only to match the patterns above. It is not possible to classify by
 * `detail`: `errorToText` goes down to the innermost message and discards sibling
 * fields — and several providers send the reason in `code`/`type`, not in the
 * message (e.g. `{ error: { code: 'content_filter', message: 'The response was
 * filtered' } }`). Here we serialize the whole structure.
 */
function matchable(value: unknown): string {
  const text = errorToText(value)
  if (typeof value !== 'object' || value === null) return text
  const seen = new WeakSet<object>()
  let serialized = ''
  try {
    serialized = JSON.stringify(value, (key, val) => {
      // Response headers are LEFT OUT. The SDK's APICallError keeps
      // `responseHeaders`, and practically every OpenAI-compatible provider
      // returns `x-ratelimit-*` on EVERY response, including the ones that
      // succeeded. Serializing them made the /rate[ _-]?limit/ pattern match on
      // any failure of those providers: a context overflow error
      // reached the user as "the provider hit the usage limit". The reason
      // real one comes from the body (`responseBody`, `code`, `type`) and from `statusCode`,
      // which stay here.
      if (key === 'responseHeaders') return undefined
      // The REQUEST body is also left out: it is the whole prompt
      // (conversation, system, tool descriptions), written by us and by the
      // user, not by the provider. An "is not supported" in any message
      // made a DNS failure become "the provider does not serve this model".
      if (key === 'requestBodyValues') return undefined
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return undefined
        seen.add(val)
      }
      return val
    })
  } catch {
    // exotic objects (getters that throw, BigInt) — the text is enough
  }
  // Error has non-enumerable properties: JSON.stringify(new Error(x)) === '{}'
  return serialized && serialized !== '{}' ? `${text}\n${serialized}` : text
}

/**
 * Classifies a turn's failure so the UI can decide what to offer. The raw text
 * is never discarded: the friendly message is assembled in the renderer (i18n) from
 * the `kind`, and the `detail` stays visible for diagnosis.
 */
export function classifyProviderError(value: unknown): ClassifiedError {
  const detail = errorToText(value)
  // CONFIGURATION failure (unknown provider/SDK, missing key) before
  // any pattern: the text is ours, not the provider's — and a provider id with
  // a "429" in the middle would match rate-limit.
  if (isProviderConfigError(value)) return { kind: 'provider-config', detail }
  let haystack = detail
  try {
    haystack = matchable(value)
  } catch {
    // classifying is best-effort — it can never bring down the catch that called us
  }
  // Context overflow comes before everything: the provider's message is unambiguous,
  // and letting it fall into any rotatable kind makes the engine repeat a
  // request that cannot possibly work.
  if (CONTEXT_LENGTH_PATTERNS.some((re) => re.test(haystack))) {
    return { kind: 'context-length', detail }
  }
  if (MODERATION_PATTERNS.some((re) => re.test(haystack))) return { kind: 'moderation', detail }
  if (MODEL_UNAVAILABLE_PATTERNS.some((re) => re.test(haystack))) {
    return { kind: 'model-unavailable', detail }
  }
  if (SESSION_ROUTING_PATTERNS.some((re) => re.test(haystack))) return { kind: 'network', detail }
  // Too many tools before rate-limit: the message brings "limit" and would fall into the
  // rotatable kind, which tells you to switch models — and the ceiling is the endpoint's.
  if (TOOL_LIMIT_PATTERNS.some((re) => re.test(haystack))) return { kind: 'tool-limit', detail }
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(haystack))) return { kind: 'rate-limit', detail }
  if (NETWORK_PATTERNS.some((re) => re.test(haystack))) return { kind: 'network', detail }
  return { kind: 'unknown', detail }
}

/** Kinds that the model rotation works around automatically (switching models
 *  solves it). Auth (401/403) and manual abort are left out on purpose, and so
 *  is `context-length`: the payload is the same on any model. */
const RECOVERABLE_ERROR_KINDS: ReadonlySet<MessageErrorKind> = new Set([
  'moderation',
  'model-unavailable',
  'rate-limit',
  'network',
])

export function isRecoverableErrorKind(kind: MessageErrorKind): boolean {
  return RECOVERABLE_ERROR_KINDS.has(kind)
}

/** Kinds that pass on their own with time, on the SAME model — the only ones in which
 *  it is worth repeating the turn after a wait (SendMessageOptions.retries).
 *  Moderation and model unavailable are left out: they are recoverable through the
 *  rotation, but repeating the same request to the same model fails the same way. */
const TRANSIENT_ERROR_KINDS: ReadonlySet<MessageErrorKind> = new Set(['rate-limit', 'network'])

export function isTransientErrorKind(kind: MessageErrorKind): boolean {
  return TRANSIENT_ERROR_KINDS.has(kind)
}
