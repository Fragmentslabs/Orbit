import type { FragmentCallResult, FragmentManifest } from '@shared/fragments'
import { normalizeFragmentHost } from '@shared/fragments'
import { createBudget } from './fragment-budget'
import { httpsTransport, type Transport } from './fragment-http-transport'

/**
 * `orbit.http.fetch` — the page asks, the main process fetches.
 *
 * The page never opens a connection itself (its CSP closes the network). A request is
 * served only if: the URL is https on the default port without credentials, the host is
 * one of `manifest.hosts` (re-checked on every redirect hop), no cookie or credential
 * header is sent, and the call stays inside the caps below.
 */

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
/** Headers the page may not set: credentials, and the ones the HTTP stack owns. */
const FORBIDDEN_HEADERS = new Set([
  'cookie', 'cookie2', 'authorization', 'proxy-authorization', 'host', 'content-length', 'connection',
  'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect', 'accept-encoding', 'origin', 'referer',
])

export const HTTP_LIMITS = {
  maxRequestBodyBytes: 256 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  timeoutMs: 20_000,
  maxRedirects: 3,
  maxHeaders: 20,
  perMinute: 30,
  concurrent: 4,
} as const

const budget = createBudget({ label: 'orbit.http', perMinute: HTTP_LIMITS.perMinute, concurrent: HTTP_LIMITS.concurrent })

function fail(code: string, message: string): FragmentCallResult {
  return { ok: false, error: { code, message } }
}

class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** The URL, if it is one this fragment may fetch. Throws a Refusal otherwise. */
export function checkUrl(raw: unknown, hosts: string[]): URL {
  if (typeof raw !== 'string' || !raw.trim()) throw new Refusal('invalid_params', 'orbit.http.fetch needs a url string')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Refusal('invalid_params', 'The url is not valid')
  }
  if (url.protocol !== 'https:') throw new Refusal('invalid_params', 'Only https:// urls are allowed')
  if (url.username || url.password) throw new Refusal('invalid_params', 'Credentials in the url are not allowed')
  if (url.port && url.port !== '443') throw new Refusal('invalid_params', 'Only the default https port is allowed')
  const host = normalizeFragmentHost(url.hostname)
  if (!host || !hosts.includes(host)) {
    throw new Refusal('host_not_allowed', `${url.hostname} is not one of the hosts this fragment declared`)
  }
  return url
}

function checkHeaders(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Refusal('invalid_params', 'headers must be an object')
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > HTTP_LIMITS.maxHeaders) throw new Refusal('invalid_params', `at most ${HTTP_LIMITS.maxHeaders} headers`)
  const out: Record<string, string> = {}
  for (const [name, value] of entries) {
    const key = name.toLowerCase()
    if (!/^[a-z0-9-]{1,60}$/.test(key)) throw new Refusal('invalid_params', `invalid header name: ${name.slice(0, 40)}`)
    if (FORBIDDEN_HEADERS.has(key) || key.startsWith('proxy-') || key.startsWith('sec-')) {
      throw new Refusal('invalid_params', `The header "${key}" cannot be set from a fragment`)
    }
    if (typeof value !== 'string' || value.length > 2000 || /[\r\n]/.test(value)) {
      throw new Refusal('invalid_params', `invalid value for header ${key}`)
    }
    out[key] = value
  }
  return out
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

export async function fragmentHttpFetch(
  manifest: FragmentManifest,
  params: Record<string, unknown>,
  transport: Transport = httpsTransport,
): Promise<FragmentCallResult> {
  let url: URL
  let method: string
  let headers: Record<string, string>
  let body: string | undefined
  try {
    url = checkUrl(params.url, manifest.hosts)
    method = typeof params.method === 'string' ? params.method.toUpperCase() : 'GET'
    if (!METHODS.has(method)) throw new Refusal('invalid_params', `Method not allowed: ${method.slice(0, 20)}`)
    headers = checkHeaders(params.headers)
    if (params.body !== undefined && params.body !== null) {
      if (typeof params.body !== 'string') throw new Refusal('invalid_params', 'body must be a string (stringify JSON yourself)')
      if (method === 'GET' || method === 'HEAD') throw new Refusal('invalid_params', `${method} cannot carry a body`)
      if (Buffer.byteLength(params.body, 'utf8') > HTTP_LIMITS.maxRequestBodyBytes) {
        throw new Refusal('invalid_params', `body too large (limit ${HTTP_LIMITS.maxRequestBodyBytes / 1024}KB)`)
      }
      body = params.body
    }
  } catch (err) {
    if (err instanceof Refusal) return fail(err.code, err.message)
    throw err
  }

  const slot = budget.take(manifest.id)
  if ('refused' in slot) return fail('rate_limited', slot.refused)
  const deadline = Date.now() + HTTP_LIMITS.timeoutMs
  try {
    for (let hop = 0; ; hop++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return fail('http_failed', 'timed out')
      const res = await transport({
        url,
        method,
        headers: { 'user-agent': 'Orbit-Fragment', 'accept-encoding': 'identity', ...headers },
        body,
        timeoutMs: remaining,
        maxBytes: HTTP_LIMITS.maxResponseBytes,
      })
      const location = res.headers.location
      if (isRedirect(res.status) && location) {
        if (hop >= HTTP_LIMITS.maxRedirects) return fail('http_failed', 'too many redirects')
        // Every hop is judged like the first request: a redirect cannot leave the allowlist.
        url = checkUrl(new URL(location, url).toString(), manifest.hosts)
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET'
          body = undefined
        }
        continue
      }
      return {
        ok: true,
        value: {
          status: res.status,
          ok: res.status >= 200 && res.status < 300,
          url: url.toString(),
          headers: res.headers,
          text: res.body.toString('utf8'),
          truncated: res.truncated,
        },
      }
    }
  } catch (err) {
    if (err instanceof Refusal) return fail(err.code, `Redirect refused: ${err.message}`)
    return fail('http_failed', err instanceof Error ? err.message : String(err))
  } finally {
    slot.release()
  }
}
