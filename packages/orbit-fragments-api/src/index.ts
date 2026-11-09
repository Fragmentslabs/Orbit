/**
 * The `window.orbit` API a fragment page runs against, as types.
 *
 * Add `orbit-fragments-api` to a fragment project and every script of the page sees a
 * typed global `orbit`:
 *
 *   // @ts-check
 *   /// <reference types="orbit-fragments-api" />
 *   const { text } = await orbit.ai.generate({ prompt: 'Hello' })
 *
 * The API is versioned by its major, the `sdk` field of the fragment's manifest. A
 * fragment written against `sdk: 1` keeps working for as long as the app ships sdk 1.
 */

/** Major version of the `window.orbit` API (the bridge protocol) these declarations describe. */
export const ORBIT_SDK_VERSION = 1

/** Every method the page reaches through the bridge; the app refuses any other. */
export const ORBIT_BRIDGE_METHODS = [
  'store.get',
  'store.set',
  'store.delete',
  'store.keys',
  'ai.generate',
  'models.list',
  'models.get',
  'models.set',
  'http.fetch',
  'mcp.list',
  'mcp.call',
] as const

export type OrbitBridgeMethod = (typeof ORBIT_BRIDGE_METHODS)[number]

/** What a fragment can ask for in its manifest's `requests`. The person grants them, never the fragment. */
export type OrbitCapability = 'ai' | 'models' | 'http' | 'mcp'

/** True when a manifest written for `sdk` runs on the API these declarations describe. */
export function isCompatibleSdk(sdk: unknown): boolean {
  return sdk === ORBIT_SDK_VERSION
}

/** Why a call to `orbit` failed; `error.code` is one of these (or `timeout`). */
export type OrbitErrorCode =
  | 'not_found'
  | 'unknown_method'
  | 'permission_denied'
  | 'invalid_params'
  | 'no_model'
  | 'rate_limited'
  | 'ai_failed'
  | 'http_failed'
  | 'tool_not_allowed'
  | 'mcp_unavailable'
  | 'mcp_tool_error'
  | 'mcp_failed'
  | 'failed'
  | 'timeout'

export interface OrbitError extends Error {
  code: OrbitErrorCode | string
}

export interface OrbitGenerateOptions {
  /** At most 30,000 characters. */
  prompt: string
  /** At most 8,000 characters. */
  system?: string
}

/** A model the fragment may offer in its own UI. Names only: never a key, endpoint or price. */
export interface OrbitModelOption {
  providerId: string
  providerName: string
  modelId: string
  name: string
  /** The model can think. */
  reasoning: boolean
}

export interface OrbitModelChoice {
  providerId: string
  modelId: string
}

export type OrbitTheme = 'light' | 'dark'

export interface OrbitStore {
  /** Resolves `null` for a key that was never saved. */
  get<T = unknown>(key: string): Promise<T | null>
  /** JSON-serializable values only. */
  set(key: string, value: unknown): Promise<null>
  delete(key: string): Promise<null>
  keys(): Promise<string[]>
}

export interface OrbitAi {
  /** Needs "ai" in the manifest's `requests` and the person's permission. */
  generate(options: OrbitGenerateOptions): Promise<{ text: string }>
}

export interface OrbitModels {
  /** Needs "models" in the manifest's `requests` and the person's permission. */
  list(): Promise<OrbitModelOption[]>
  /** The model picked for this fragment, or `null` when it follows the chat. */
  get(): Promise<OrbitModelChoice | null>
  /** Pick a model from `list()`; `{}` goes back to following the chat. */
  set(model?: Partial<OrbitModelChoice>): Promise<null>
}

export interface OrbitHttpOptions {
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Harmless headers only: credentials and cookies are never forwarded. */
  headers?: Record<string, string>
  /** A string; stringify JSON yourself. Not allowed with GET or HEAD. */
  body?: string
}

export interface OrbitHttpResponse {
  status: number
  ok: boolean
  url: string
  headers: Record<string, string>
  text: string
  /** The body was cut at the size cap. */
  truncated: boolean
  json<T = unknown>(): T
}

export interface OrbitHttp {
  /** Needs "http" in `requests`, the host in the manifest's `hosts` (https), and the person's permission. */
  fetch(url: string, options?: OrbitHttpOptions): Promise<OrbitHttpResponse>
}

export interface OrbitMcpServer {
  server: string
  /** The server is connected right now. */
  connected: boolean
  tools: { name: string; available: boolean }[]
}

export interface OrbitMcp {
  /** Needs "mcp" in `requests`: the servers and tools the manifest declared, and whether each is up. */
  list(): Promise<OrbitMcpServer[]>
  call(server: string, tool: string, args?: Record<string, unknown>): Promise<{ text: string; truncated: boolean }>
}

export interface OrbitEvents {
  theme: OrbitTheme
}

export interface Orbit {
  /** Major version of the API the running app provides. */
  readonly sdk: number
  /** Current theme; kept up to date, and `on('theme', …)` tells when it changes. */
  readonly theme: OrbitTheme
  readonly store: OrbitStore
  readonly ai: OrbitAi
  readonly models: OrbitModels
  readonly http: OrbitHttp
  readonly mcp: OrbitMcp
  /** Subscribe to an event; returns the function that unsubscribes. */
  on<K extends keyof OrbitEvents>(name: K, listener: (data: OrbitEvents[K]) => void): () => void
}

declare global {
  interface Window {
    orbit: Orbit
  }
  // Fragment scripts use the bare `orbit`.
  // eslint-disable-next-line no-var
  var orbit: Orbit
}
