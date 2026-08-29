/**
 * OAuth 2.1 para servidores MCP HTTP (Streamable HTTP).
 *
 * Implementa o OAuthClientProvider do SDK (@modelcontextprotocol/sdk):
 * registro dinâmico de cliente (RFC 7591) *ou* credenciais pré-registradas,
 * PKCE (RFC 7636) e authorization code com redirect loopback em
 * http://127.0.0.1:<porta>/callback.
 *
 * Fluxo:
 * 1. O transport HTTP recebe 401 do servidor, chama redirectToAuthorization()
 *    e lança UnauthorizedError; o provider grava um "pending flow" por URL.
 * 2. No fluxo interativo (botão Autorizar) o navegador abre via
 *    shell.openExternal; no fluxo automático (startup/reconnect) nada abre —
 *    o connect sinaliza estado "unauthorized" para a UI.
 * 3. O redirect do navegador cai no servidor HTTP local (/callback), que
 *    roteia o code pelo parâmetro state e resolve o pending flow.
 * 4. O connect chama transport.finishAuth(code) e reconecta num transport novo.
 *
 * Tokens, client info, code verifier e discovery ficam persistidos em
 * orbit-data/mcp-oauth.json (por URL do servidor), permitindo reuso e
 * refresh automático entre sessões. Se a porta do loopback mudar entre
 * execuções (porta ocupada), o client info antigo é invalidado e um novo
 * registro dinâmico acontece na próxima autorização.
 *
 * Nem todo servidor aceita registro dinâmico: alguns (o Figma, por exemplo)
 * respondem 403 ao /register de clientes fora de uma allowlist. Para esses,
 * a config do servidor aceita clientId/clientSecret de um app OAuth já
 * criado no provedor — nesse caso o registro é pulado por completo.
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

/** Tempo máximo para o usuário concluir a autorização no navegador. */
const AUTH_TIMEOUT_MS = 5 * 60_000
/** Portas candidatas para o loopback (a primeira livre vence; a salva tem prioridade). */
const LOOPBACK_CANDIDATES = [38371, 39457, 40501, 42123]
const CALLBACK_PATH = '/callback'
/** client_name enviado no registro dinâmico quando a config não define outro. */
const DEFAULT_CLIENT_NAME = 'Orbit'

interface OAuthStoreClient {
  redirectUrl: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  discoveryState?: OAuthDiscoveryState
  /** PKCE verifier do fluxo em andamento (sobrevive a um reload do main). */
  codeVerifier?: string
  /** state do fluxo em andamento (o AS do Figma exige state). */
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
/*  Persistência (orbit-data/mcp-oauth.json)                            */
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
      // falha de persistência não derruba o fluxo — só perde a sessão no restart
    })
}

/* ------------------------------------------------------------------ */
/*  Servidor loopback (http://127.0.0.1:<porta>/callback)               */
/* ------------------------------------------------------------------ */

let loopbackServer: http.Server | null = null
let loopbackPort = 0

/** pending flows por URL do servidor MCP (um por servidor, o novo substitui o anterior). */
const pendingFlows = new Map<string, PendingFlow>()

/** Servidores cujo próximo fluxo OAuth deve abrir o navegador. */
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
  // Com state, casa o callback com o servidor certo; sem ele (servidores que
  // não ecoam state) só dá para assumir quando existe um único fluxo aberto.
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
    flow.reject(new Error(`Autorização recusada: ${description || error}`))
    res.end(HTML_ERROR)
  } else if (code) {
    flow.resolve(code)
    res.end(HTML_OK)
  } else {
    flow.reject(new Error('Resposta OAuth sem code'))
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
        // nunca chegou a escutar
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
 * Garante o servidor loopback rodando e devolve a porta usada. Tenta a porta
 * salva primeiro (para manter registros OAuth válidos entre sessões), depois
 * candidatas fixas e, por fim, uma efêmera. Se a porta mudar, o client
 * information antigo é descartado (redirect_uri não bate mais).
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
  throw lastErr ?? new Error('impossível abrir o loopback OAuth')
}

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

class OAuthProvider implements OAuthClientProvider {
  /** Config OAuth do mcp-config.json (client pré-registrado, nome, escopo). */
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
      // token_endpoint_auth_method fica de fora de propósito: o servidor de
      // autorização decide no registro (RFC 7591) e o SDK (selectClientAuthMethod)
      // usa o método devolvido ou o melhor suportado — fixar "none" quebra
      // servidores que só aceitam client_secret_basic/post (ex.: o AS do Figma).
    }
  }

  /**
   * Credenciais da config têm prioridade: com um client_id de app já
   * registrado, o SDK pula o registro dinâmico (que alguns provedores
   * bloqueiam com 403).
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
      throw new Error('Fluxo OAuth sem code verifier — autorize novamente')
    }
    return this.client.codeVerifier
  }

  /**
   * state do authorization request. Além do CSRF, é o que casa o callback
   * com o servidor certo — e alguns AS o exigem (o do Figma anuncia
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
    if (!interactive) return // fluxo automático: UI mostra "Autorizar" em vez de abrir o navegador
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
    // Quando o timeout dispara pode não haver mais ninguém esperando (o
    // connect já desistiu); sem este catch a rejeição vira unhandled.
    flow.promise.catch(() => {})
    flow.timer = setTimeout(() => {
      pendingFlows.delete(this.serverUrl)
      flow.reject(new Error('Autorização não concluída no navegador (tempo esgotado)'))
    }, AUTH_TIMEOUT_MS)
    pendingFlows.set(this.serverUrl, flow)
    try {
      await shell.openExternal(authorizationUrl.toString())
    } catch {
      // sem browser não dá para autorizar; o timeout resolve o fluxo
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
 * Provider (cacheado por URL) que o transport HTTP usa para autenticar.
 * `options` vem da config do servidor e é reaplicada a cada chamada — editar
 * o servidor na UI passa a valer já na próxima conexão.
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
 * redirect_uri que o Orbit usa no fluxo — o usuário precisa cadastrá-lo no
 * app OAuth criado no provedor. Sobe o loopback para saber a porta real.
 */
export async function oauthRedirectUrl(): Promise<string> {
  return callbackUrl(await ensureOAuthLoopback())
}

/** true quando já existe token OAuth salvo para o servidor (autorizado alguma vez). */
export async function hasOAuthTokens(serverUrl: string): Promise<boolean> {
  const file = await loadStore()
  return Boolean(file.clients[serverUrl]?.tokens?.access_token)
}

/** Esquece tokens/registro do servidor (reautorização do zero). */
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

/** Marca o próximo fluxo do servidor como interativo (abre o navegador). */
export function setOAuthInteractive(serverUrl: string, interactive: boolean): void {
  if (interactive) interactiveServers.add(serverUrl)
  else interactiveServers.delete(serverUrl)
}

/**
 * Aguarda o code do fluxo pendente do servidor. Resolve null quando o fluxo
 * não foi iniciado (não-interativo) ou foi cancelado; rejeita em timeout/erro.
 */
export async function awaitPendingAuth(serverUrl: string): Promise<string | null> {
  const flow = pendingFlows.get(serverUrl)
  if (!flow) return null
  return flow.promise
}

/** Cancela o fluxo pendente do servidor (disconnect/reconnect). */
export function cancelPendingAuth(serverUrl: string): void {
  pendingFlows.get(serverUrl)?.resolve(null)
  pendingFlows.delete(serverUrl)
}

/**
 * Traduz erros crus do fluxo OAuth em algo acionável na UI.
 *
 * O caso mais comum é o servidor recusar o registro dinâmico (RFC 7591):
 * provedores como o Figma só aceitam /register de clientes de uma allowlist
 * e devolvem `403 Forbidden` em texto puro, que o SDK repassa como
 * "Invalid OAuth error response ... Raw body: Forbidden". A mensagem aqui
 * diz o que fazer: cadastrar um client_id/client_secret próprio.
 */
export function describeOAuthError(err: unknown, hasStaticClient: boolean): string | undefined {
  const message = err instanceof Error ? err.message : String(err ?? '')
  if (!message) return undefined
  if (/does not support dynamic client registration/i.test(message)) {
    return 'O servidor de autorização não oferece registro dinâmico de clientes. Informe o Client ID/Client Secret de um app OAuth já criado nas opções OAuth deste servidor (botão Editar).'
  }
  if (
    !hasStaticClient &&
    /Invalid OAuth error response/i.test(message) &&
    /HTTP (401|403)/.test(message)
  ) {
    const status = message.match(/HTTP (401|403)/)?.[1] ?? '403'
    return `O servidor recusou o registro dinâmico de cliente OAuth (HTTP ${status}) — ele só aceita clientes pré-cadastrados. Crie um app OAuth no provedor e informe o Client ID/Client Secret nas opções OAuth deste servidor (botão Editar).`
  }
  return undefined
}

/** Fecha o loopback no shutdown (senão o event loop segura o processo). */
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
