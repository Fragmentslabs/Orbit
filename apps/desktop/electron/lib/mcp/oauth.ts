/**
 * OAuth 2.1 for MCP HTTP servers (Streamable HTTP).
 *
 * Implements the SDK's OAuthClientProvider (@modelcontextprotocol/sdk): dynamic client
 * registration (RFC 7591) *or* pre-registered credentials, PKCE (RFC 7636) and
 * authorization code with a loopback redirect at http://127.0.0.1:<port>/callback.
 *
 * Flow:
 * 1. The HTTP transport receives a 401 from the server, calls redirectToAuthorization()
 *    and throws UnauthorizedError; the provider stores a "pending flow" per URL.
 * 2. In the interactive flow (Authorize button) the browser opens via
 *    shell.openExternal; in the automatic flow (startup/reconnect) nothing opens —
 *    connect signals the "unauthorized" state to the UI.
 * 3. The browser redirect lands on the local HTTP server (/callback), which routes the
 *    code through the state parameter and resolves the pending flow.
 * 4. connect calls transport.finishAuth(code) and reconnects on a new transport.
 *
 * Tokens, client info, code verifier and discovery stay persisted in
 * orbit-data/mcp-oauth.json (per server URL), allowing reuse and automatic refresh
 * between sessions. If the loopback port changes between runs (port taken), the old
 * client info is invalidated and a new dynamic registration happens on the next
 * authorization.
 *
 * Not every server accepts dynamic registration: some (Figma, for instance) answer 403
 * to /register from clients outside an allowlist. For those, the server config accepts
 * clientId/clientSecret of an OAuth app already created in the provider — in that case
 * the registration is skipped entirely.
 */
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { shell } from 'electron'
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpOAuthConfig } from '@shared/mcp'
import { dataDir } from '../storage'

/** Maximum time for the user to complete the authorization in the browser. */
const AUTH_TIMEOUT_MS = 5 * 60_000
/** Candidate ports for the loopback (the first free one wins; the saved one has priority). */
const LOOPBACK_CANDIDATES = [38371, 39457, 40501, 42123]
const CALLBACK_PATH = '/callback'
/** client_name sent in the dynamic registration when the config does not define another one. */
const DEFAULT_CLIENT_NAME = 'Orbit'

interface OAuthStoreClient {
  redirectUrl: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  discoveryState?: OAuthDiscoveryState
  /** PKCE verifier of the flow in progress (survives a reload of main). */
  codeVerifier?: string
  /** state of the flow in progress (Figma's AS requires state). */
  state?: string
}

interface OAuthStoreFile {
  port?: number
  clients: Record<string, OAuthStoreClient>
}

interface PendingFlow {
  state: string
  serverUrl: string
  promise: Promise<string | null>
  resolve: (code: string | null) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/* ------------------------------------------------------------------ */
/*  Persistence (orbit-data/mcp-oauth.json)                             */
/* ------------------------------------------------------------------ */

let store: OAuthStoreFile | null = null

function storePath(): string {
  return path.join(dataDir(), 'mcp-oauth.json')
}

async function loadStore(): Promise<OAuthStoreFile> {
  if (store) return store
  try {
    store = JSON.parse(await fsp.readFile(storePath(), 'utf8')) as OAuthStoreFile
  } catch {
    store = { clients: {} }
  }
  if (!store || typeof store !== 'object') store = { clients: {} }
  if (!store.clients || typeof store.clients !== 'object') store.clients = {}
  return store
}

function persistStore(): void {
  if (!store) return
  void fsp
    .mkdir(dataDir(), { recursive: true })
    .then(() => fsp.writeFile(storePath(), JSON.stringify(store, null, 2), 'utf8'))
    .catch(() => {
      // a persistence failure does not take the flow down — it only loses the session on restart
    })
}

/* ------------------------------------------------------------------ */
/*  Loopback server (http://127.0.0.1:<port>/callback)                  */
/* ------------------------------------------------------------------ */

let loopbackServer: http.Server | null = null
let loopbackPort = 0

/** pending flows by MCP server URL (one per server, the new one replaces the previous). */
const pendingFlows = new Map<string, PendingFlow>()

/** Servers whose next OAuth flow must open the browser. */
const interactiveServers = new Set<string>()

const HTML_OK =
  '<!doctype html><html lang="pt"><meta charset="utf-8"><title>Orbit — MCP</title>' +
  '<body style="font-family:system-ui;background:#0f0f13;color:#eee;display:grid;place-items:center;height:100vh;margin:0;text-align:center">' +
  '<p>Autorização concluída — você já pode fechar esta aba.<br>' +
  '<small>Authorization complete — you may close this tab.</small></p></body></html>'

const HTML_ERROR =
  '<!doctype html><html lang="pt"><meta charset="utf-8"><title>Orbit — MCP</title>' +
  '<body style="font-family:system-ui;background:#0f0f13;color:#eee;display:grid;place-items:center;height:100vh;margin:0;text-align:center">' +
  '<p>Autorização não concluída — você pode fechar esta aba.<br>' +
  '<small>Authorization was not completed — you may close this tab.</small></p></body></html>'

function findFlow(state: string): PendingFlow | undefined {
  for (const flow of pendingFlows.values()) {
    if (flow.state === state) return flow
  }
  return undefined
}

function singleFlow(): PendingFlow | undefined {
  return pendingFlows.size === 1 ? [...pendingFlows.values()][0] : undefined
}

function handleCallback(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${loopbackPort}`)
  if (url.pathname !== CALLBACK_PATH) {
    res.statusCode = 404
    res.end()
    return
  }
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')
  const description = url.searchParams.get('error_description')
  // With state, it matches the callback to the right server; without it (servers that do
  // not echo state) all one can do is assume when there is a single flow open.
  const flow = state ? findFlow(state) : singleFlow()
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  if (!flow) {
    res.statusCode = 404
    res.end(HTML_ERROR)
    return
  }
  pendingFlows.delete(flow.serverUrl)
  clearTimeout(flow.timer)
  if (error) {
    flow.reject(new Error(`Authorization refused: ${description || error}`))
    res.end(HTML_ERROR)
  } else if (code) {
    flow.resolve(code)
    res.end(HTML_OK)
  } else {
    flow.reject(new Error('OAuth response with no code'))
    res.end(HTML_ERROR)
  }
}

function bindLoopback(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleCallback)
    server.once('error', (err) => {
      server.removeAllListeners('error')
      try {
        server.close()
      } catch {
        // never got to listen
      }
      reject(err as Error)
    })
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      loopbackServer = server
      loopbackPort = typeof addr === 'object' && addr ? addr.port : port
      resolve(loopbackPort)
    })
  })
}

function callbackUrl(port: number): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`
}

/**
 * Guarantees the loopback server is running and returns the port in use. It tries the
 * saved port first (to keep OAuth registrations valid between sessions), then fixed
 * candidates and, finally, an ephemeral one. If the port changes, the old client
 * information is discarded (the redirect_uri no longer matches).
 */
export async function ensureOAuthLoopback(): Promise<number> {
  if (loopbackServer) return loopbackPort
  const file = await loadStore()
  const candidates = [...new Set([...(file.port ? [file.port] : []), ...LOOPBACK_CANDIDATES, 0])]
  let lastErr: Error | null = null
  for (const candidate of candidates) {
    try {
      const port = await bindLoopback(candidate)
      if (port !== file.port) {
        file.port = port
        const redirectUrl = callbackUrl(port)
        for (const stored of Object.values(file.clients)) {
          if (stored.redirectUrl !== redirectUrl) {
            stored.redirectUrl = redirectUrl
            delete stored.clientInformation
            delete stored.discoveryState
          }
        }
        persistStore()
      }
      return port
    } catch (err) {
      lastErr = err as Error
    }
  }
  throw lastErr ?? new Error('cannot open the OAuth loopback')
}

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

class OAuthProvider implements OAuthClientProvider {
  /** OAuth config from mcp-config.json (pre-registered client, name, scope). */
  options: McpOAuthConfig = {}

  constructor(
    private readonly serverUrl: string,
    private readonly client: OAuthStoreClient,
  ) {}

  get redirectUrl(): string {
    return callbackUrl(loopbackPort)
  }

  get clientMetadata(): OAuthClientMetadata {
    const scope = this.options.scope?.trim()
    return {
      client_name: this.options.clientName?.trim() || DEFAULT_CLIENT_NAME,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(scope ? { scope } : {}),
      // token_endpoint_auth_method stays out on purpose: the authorization server decides at
      // registration (RFC 7591) and the SDK (selectClientAuthMethod) uses the returned method
      // or the best supported one — pinning "none" breaks servers that only accept
      // client_secret_basic/post (e.g. Figma's AS).
    }
  }

  /**
   * Credentials from the config have priority: with a client_id of an app already
   * registered, the SDK skips the dynamic registration (which some providers block with
   * 403).
   */
  clientInformation(): OAuthClientInformationMixed | undefined {
    const clientId = this.options.clientId?.trim()
    if (clientId) {
      const clientSecret = this.options.clientSecret?.trim()
      return { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) }
    }
    return this.client.clientInformation
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.client.clientInformation = clientInformation
    persistStore()
  }

  tokens(): OAuthTokens | undefined {
    return this.client.tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.client.tokens = tokens
    delete this.client.codeVerifier
    delete this.client.state
    persistStore()
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.client.codeVerifier = codeVerifier
    persistStore()
  }

  codeVerifier(): string {
    if (!this.client.codeVerifier) {
      throw new Error('OAuth flow with no code verifier — authorize again')
    }
    return this.client.codeVerifier
  }

  /**
   * state of the authorization request. Besides CSRF, it is what matches the callback to
   * the right server — and some ASs require it (Figma's announces
   * `require_state_parameter: true`).
   */
  state(): string {
    const value = `orb-${randomUUID()}`
    this.client.state = value
    persistStore()
    return value
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const interactive = interactiveServers.has(this.serverUrl)
    if (!interactive) return // automatic flow: the UI shows "Authorize" instead of opening the browser
    const state =
      authorizationUrl.searchParams.get('state') ?? this.client.state ?? `orb-${randomUUID()}`
    this.cancelPending()
    const flow: PendingFlow = {
      state,
      serverUrl: this.serverUrl,
      promise: null!,
      resolve: null!,
      reject: null!,
      timer: null!,
    }
    flow.promise = new Promise<string | null>((resolve, reject) => {
      flow.resolve = resolve
      flow.reject = reject
    })
    // When the timeout fires there may be nobody waiting anymore (connect already gave
    // up); without this catch the rejection becomes unhandled.
    flow.promise.catch(() => {})
    flow.timer = setTimeout(() => {
      pendingFlows.delete(this.serverUrl)
      flow.reject(new Error('Authorization not completed in the browser (timed out)'))
    }, AUTH_TIMEOUT_MS)
    pendingFlows.set(this.serverUrl, flow)
    try {
      await shell.openExternal(authorizationUrl.toString())
    } catch {
      // without a browser there is no way to authorize; the timeout settles the flow
    }
  }

  private cancelPending(): void {
    const flow = pendingFlows.get(this.serverUrl)
    if (!flow) return
    pendingFlows.delete(this.serverUrl)
    clearTimeout(flow.timer)
    flow.resolve(null)
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    switch (scope) {
      case 'all':
        delete this.client.clientInformation
        delete this.client.tokens
        delete this.client.discoveryState
        delete this.client.codeVerifier
        break
      case 'client':
        delete this.client.clientInformation
        break
      case 'tokens':
        delete this.client.tokens
        break
      case 'discovery':
        delete this.client.discoveryState
        break
      case 'verifier':
        delete this.client.codeVerifier
        break
    }
    persistStore()
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.client.discoveryState = state
    persistStore()
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.client.discoveryState
  }
}

const providers = new Map<string, OAuthProvider>()

/**
 * Provider (cached by URL) that the HTTP transport uses to authenticate. `options`
 * comes from the server config and is reapplied on every call — editing the server in
 * the UI starts to apply on the next connection already.
 */
export async function getOAuthProvider(
  serverUrl: string,
  options: McpOAuthConfig = {},
): Promise<OAuthClientProvider> {
  const file = await loadStore()
  let stored = file.clients[serverUrl]
  if (!stored) {
    stored = { redirectUrl: callbackUrl(loopbackPort) }
    file.clients[serverUrl] = stored
    persistStore()
  }
  let provider = providers.get(serverUrl)
  if (!provider) {
    provider = new OAuthProvider(serverUrl, stored)
    providers.set(serverUrl, provider)
  }
  provider.options = options
  return provider
}

/**
 * redirect_uri that Orbit uses in the flow — the user has to register it in the OAuth
 * app created in the provider. It starts the loopback to find out the real port.
 */
export async function oauthRedirectUrl(): Promise<string> {
  return callbackUrl(await ensureOAuthLoopback())
}

/** true when there is already a saved OAuth token for the server (authorized at some point). */
export async function hasOAuthTokens(serverUrl: string): Promise<boolean> {
  const file = await loadStore()
  return Boolean(file.clients[serverUrl]?.tokens?.access_token)
}

/** Forgets the server's tokens/registration (reauthorization from scratch). */
export async function forgetOAuth(serverUrl: string): Promise<void> {
  const file = await loadStore()
  const stored = file.clients[serverUrl]
  if (!stored) return
  delete stored.tokens
  delete stored.clientInformation
  delete stored.discoveryState
  delete stored.codeVerifier
  delete stored.state
  persistStore()
}

/** Marks the server's next flow as interactive (opens the browser). */
export function setOAuthInteractive(serverUrl: string, interactive: boolean): void {
  if (interactive) interactiveServers.add(serverUrl)
  else interactiveServers.delete(serverUrl)
}

/**
 * Waits for the code of the server's pending flow. It resolves null when the flow was
 * not started (non-interactive) or was cancelled; it rejects on timeout/error.
 */
export async function awaitPendingAuth(serverUrl: string): Promise<string | null> {
  const flow = pendingFlows.get(serverUrl)
  if (!flow) return null
  return flow.promise
}

/** Cancels the server's pending flow (disconnect/reconnect). */
export function cancelPendingAuth(serverUrl: string): void {
  pendingFlows.get(serverUrl)?.resolve(null)
  pendingFlows.delete(serverUrl)
}

/**
 * Translates raw errors of the OAuth flow into something actionable in the UI.
 *
 * The most common case is the server refusing the dynamic registration (RFC 7591):
 * providers like Figma only accept /register from clients of an allowlist and return
 * `403 Forbidden` in plain text, which the SDK passes on as "Invalid OAuth error
 * response ... Raw body: Forbidden". The message here says what to do: register your
 * own client_id/client_secret.
 */
export function describeOAuthError(err: unknown, hasStaticClient: boolean): string | undefined {
  const message = err instanceof Error ? err.message : String(err ?? '')
  if (!message) return undefined
  if (/does not support dynamic client registration/i.test(message)) {
    return 'The authorization server does not offer dynamic client registration. Provide the Client ID/Client Secret of an OAuth app already created in the OAuth options of this server (Edit button).'
  }
  if (
    !hasStaticClient &&
    /Invalid OAuth error response/i.test(message) &&
    /HTTP (401|403)/.test(message)
  ) {
    const status = message.match(/HTTP (401|403)/)?.[1] ?? '403'
    return `The server refused the dynamic OAuth client registration (HTTP ${status}) — it only accepts pre-registered clients. Create an OAuth app with the provider and provide the Client ID/Client Secret in the OAuth options of this server (Edit button).`
  }
  return undefined
}

/** Closes the loopback on shutdown (otherwise the event loop holds the process). */
export function closeOAuthLoopback(): void {
  for (const flow of pendingFlows.values()) {
    clearTimeout(flow.timer)
    flow.resolve(null)
  }
  pendingFlows.clear()
  interactiveServers.clear()
  if (loopbackServer) {
    loopbackServer.close()
    loopbackServer = null
    loopbackPort = 0
  }
}
