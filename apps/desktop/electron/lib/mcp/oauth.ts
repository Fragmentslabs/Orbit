/**
 * OAuth 2.1 para servidores MCP HTTP (Streamable HTTP).
 *
 * Implementa o OAuthClientProvider do SDK (@modelcontextprotocol/sdk):
 * registro dinâmico de cliente (RFC 7591), PKCE (RFC 7636) e fluxo
 * authorization code com redirect loopback em http://127.0.0.1:<porta>/callback.
 *
 * Fluxo:
 * 1. O transport HTTP recebe 401 do servidor, chama redirectToAuthorization()
 *    e lança UnauthorizedError; o provider grava um "pending flow" por URL.
 * 2. No fluxo interativo (reconnect manual / botão Autorizar) o navegador
 *    abre via shell.openExternal; no fluxo automático (startup) nada abre —
 *    o connect sinaliza estado "unauthorized" para a UI.
 * 3. O redirect do navegador cai no servidor HTTP local (/callback), que
 *    roteia o code pelo parâmetro state e resolve o pending flow.
 * 4. O connect chama transport.finishAuth(code) e reconecta.
 *
 * Tokens, client info e discovery ficam persistidos em
 * orbit-data/mcp-oauth.json (por URL do servidor), permitindo reuso e
 * refresh automático entre sessões. Se a porta do loopback mudar entre
 * execuções (porta ocupada), o client info antigo é invalidado e um novo
 * registro dinâmico acontece na próxima autorização.
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
import { dataDir } from '../storage'

/** Tempo máximo para o usuário concluir a autorização no navegador. */
const AUTH_TIMEOUT_MS = 5 * 60_000
/** Portas candidatas para o loopback (a primeira livre vence; a salva tem prioridade). */
const LOOPBACK_CANDIDATES = [38371, 39457, 40501, 42123]
const CALLBACK_PATH = '/callback'

interface OAuthStoreClient {
  redirectUrl: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  discoveryState?: OAuthDiscoveryState
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
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')
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
    flow.reject(new Error(`Autorização recusada: ${error}`))
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
  private codeVerifierValue = ''

  constructor(
    private readonly serverUrl: string,
    private readonly client: OAuthStoreClient,
  ) {}

  get redirectUrl(): string {
    return callbackUrl(loopbackPort)
  }

get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Orbit',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      // token_endpoint_auth_method fica de fora de propósito: o servidor de
      // autorização decide no registro (RFC 7591) e o SDK (selectClientAuthMethod)
      // usa o método devolvido ou o melhor suportado — fixar "none" quebra
      // servidores que só aceitam client_secret_basic/post (ex.: o AS do Figma).
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
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
    persistStore()
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier
  }

  codeVerifier(): string {
    return this.codeVerifierValue
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const interactive = interactiveServers.has(this.serverUrl)
    if (!interactive) return // fluxo automático: UI mostra "Autorizar" em vez de abrir o navegador
    const state = authorizationUrl.searchParams.get('state') ?? `orb-${randomUUID()}`
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
        break // code verifier vive só em memória (mesmo processo)
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

/** Provider (cacheado por URL) que o transport HTTP usa para autenticar. */
export async function getOAuthProvider(serverUrl: string): Promise<OAuthClientProvider> {
  const file = await loadStore()
  let stored = file.clients[serverUrl]
  if (!stored) {
    stored = { redirectUrl: callbackUrl(loopbackPort) }
    file.clients[serverUrl] = stored
  }
  let provider = providers.get(serverUrl)
  if (!provider) {
    provider = new OAuthProvider(serverUrl, stored)
    providers.set(serverUrl, provider)
  }
  return provider
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