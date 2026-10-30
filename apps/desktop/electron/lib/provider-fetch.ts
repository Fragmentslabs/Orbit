import { randomUUID } from 'node:crypto'

/**
 * Contract of the OpenCode session header (Zen and Go).
 *
 * Without `x-opencode-session` the gateway answers 4xx with "Request is missing
 * x-opencode-session and cannot be routed efficiently" — the request does not even
 * get routed to any model. The value is the conversation id (stable throughout
 * it); the gateway accepts any non-empty value.
 *
 * It lives in a module without Electron and without the SDK because it is used by two sides that must
 * not know each other: resolveModel (which assembles the provider's settings) and the
 * `fetch` wrapper below — and it has to be testable outside the main process.
 */
export const SESSION_HEADER = 'x-opencode-session'

/** Providers that require the header above; the others go on without extra headers. */
export const SESSION_HEADER_PROVIDERS = new Set(['opencode', 'opencode-go'])

/** Gateway refusal for lack of a session (see the comment at the top). */
export const MISSING_SESSION_PATTERN = /missing x-opencode-session/i

/** Generates a new session id (used when the gateway refuses the conversation's). */
export function freshSessionId(): string {
  return `orbit_${randomUUID()}`
}

/**
 * Swaps the refused id for the one that started counting in the process. Whoever calls keeps the
 * decision; the wrapper only knows that it needs another value to repeat the
 * request.
 */
export type RotateSession = (rejectedId: string) => string

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return (input as Request).url || 'request without URL'
}

/**
 * `fetch` of the providers that require the session header. Two barriers:
 *
 * 1. It resends the header on EVERY request the SDK makes. It already goes in the
 *    provider's settings; this guarantees that no other path — a new version
 *    of the SDK, an option that remounts the request, an internal call that does not go through
 *    resolveModel — goes out without it. When it has to reinject, it logs it:
 *    it means the header left the expected path, and that log is what
 *    explains a session failure in the field.
 * 2. If the gateway still refuses for lack of a session, it repeats ONCE with a new
 *    id. The answer arrived without the request having been routed (no token was
 *    consumed), so repeating is safe — and without this the turn would die with an
 *    error the user has no way to work around.
 */
export function providerFetch(sessionId: string, rotate?: RotateSession): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    if (!headers.get(SESSION_HEADER)) {
      // An empty value counts as absent for the gateway — hence `||` and not `??`.
      const injected = sessionId || freshSessionId()
      console.warn(
        `[providers] request to ${urlOf(input)} went out without ${SESSION_HEADER} in the provider ` +
          `settings — reinjecting (session ${injected})`,
      )
      headers.set(SESSION_HEADER, injected)
    }

    const response = await fetch(input, { ...init, headers })
    if (response.status < 400 || init?.signal?.aborted) return response

    // Only the session refusal gets a retry, and only when the body can be
    // resent: the SDK sends JSON as a string; a stream body does not survive
    // a second call, and then the error goes up as it is.
    if (typeof init?.body !== 'string') return response
    const detail = await response
      .clone()
      .text()
      .catch(() => '')
    if (!MISSING_SESSION_PATTERN.test(detail)) return response

    const rejected = headers.get(SESSION_HEADER) ?? sessionId
    const rotated = rotate?.(rejected) ?? freshSessionId()
    console.warn(
      `[providers] gateway rejected session ${rejected} at ${urlOf(input)} — ` +
        `retrying the request with ${rotated}`,
    )
    // New headers for the retry: the first call's are not touched.
    const retryHeaders = new Headers(headers)
    retryHeaders.set(SESSION_HEADER, rotated)
    return fetch(input, { ...init, headers: retryHeaders })
  }
}
