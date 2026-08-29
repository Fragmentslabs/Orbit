import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { jsonSchema, tool, type ToolSet } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { McpConfig, McpServerConfig, McpServerStatus } from '@shared/mcp'
import type { PermissionMode } from '@shared/chat'
import { dataDir } from '../storage'
import {
  awaitPendingAuth,
  cancelPendingAuth,
  closeOAuthLoopback,
  describeOAuthError,
  ensureOAuthLoopback,
  forgetOAuth,
  getOAuthProvider,
  hasOAuthTokens,
  oauthRedirectUrl,
  setOAuthInteractive,
} from './oauth'

/**
 * Manager MCP: conecta os servidores do mcp-config.json (stdio/streamable
 * HTTP), descobre as ferramentas via tools/list e as expõe como ToolSet do
 * ai-sdk com nomes prefixados (<servidor>_<tool>). getMcpTools() é síncrono
 * (cache do manager) para encaixar no buildToolSet. Servidores com erro
 * tentam reconectar em background com backoff exponencial.
 */

const CONNECT_TIMEOUT_MS = 15_000
const RECONNECT_BASE_MS = 15_000
const RECONNECT_MAX_MS = 300_000 // 5 minutos
const RECONNECT_INTERVAL_MS = 10_000 // checa a cada 10s

interface ServerRuntime {
  config: McpServerConfig
  client: Client | null
  tools: ToolSet
  state: McpServerStatus['state']
  error?: string
  lastAttempt: number
  retryCount: number
  /** http com OAuth: já existe token salvo (autorizado alguma vez neste device) */
  authorized?: boolean
}

const servers = new Map<string, ServerRuntime>()

function configFile(): string {
  return path.join(dataDir(), 'mcp-config.json')
}

export async function readMcpConfig(): Promise<McpConfig> {
  try {
    const raw = await fsp.readFile(configFile(), 'utf8')
    const parsed = JSON.parse(raw) as McpConfig
    return { servers: Array.isArray(parsed.servers) ? parsed.servers : [] }
  } catch {
    return { servers: [] }
  }
}

async function writeMcpConfig(config: McpConfig): Promise<void> {
  await fsp.mkdir(dataDir(), { recursive: true })
  await fsp.writeFile(configFile(), JSON.stringify(config, null, 2), 'utf8')
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40)
}

function contentToText(result: unknown): string {
  const content = (result as { content?: Array<Record<string, unknown>> })?.content
  if (!Array.isArray(content)) return JSON.stringify(result)
  const parts = content.map((item) =>
    item.type === 'text' && typeof item.text === 'string' ? item.text : JSON.stringify(item),
  )
  return parts.join('\n') || '(sem retorno)'
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: timeout após ${ms / 1000}s`)), ms),
    ),
  ])
}

/**
 * URL do servidor quando ele autentica via OAuth — ou undefined.
 *
 * Um Authorization header próprio desliga o OAuth (senão um 401 por chave
 * inválida viraria um fluxo de autorização indevido); outros headers
 * (versão de API, tenant…) convivem com o OAuth numa boa.
 */
function oauthUrl(config: McpServerConfig): string | undefined {
  if (config.type !== 'http' || !config.url) return undefined
  const hasAuthHeader = Object.entries(config.headers ?? {}).some(
    ([key, value]) => key.trim().toLowerCase() === 'authorization' && value,
  )
  return hasAuthHeader ? undefined : config.url
}

/**
 * Monta o transport do servidor. Para HTTP, um authProvider OAuth é anexado
 * conforme oauthUrl(). No 401, o SDK chama redirectToAuthorization e lança
 * UnauthorizedError — o connect trata.
 */
async function buildTransport(config: McpServerConfig) {
  if (config.type === 'http') {
    if (!config.url) throw new Error('servidor http sem url')
    const headers: Record<string, string> = {}
    if (config.headers) {
      for (const [k, v] of Object.entries(config.headers)) {
        if (k.trim() && v) headers[k.trim()] = v
      }
    }
    const url = oauthUrl(config)
    const authProvider = url ? await getOAuthProvider(url, config.oauth ?? {}) : undefined
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers },
      authProvider,
    })
  }
  if (!config.command) throw new Error('servidor stdio sem command')
  const env: Record<string, string> = {}
  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) {
      if (k.trim() && v) env[k.trim()] = v
    }
  }
  const merged: Record<string, string> = {}
  if (Object.keys(env).length > 0) {
    for (const [k, v] of Object.entries(process.env)) if (v) merged[k] = v
    Object.assign(merged, env)
  }
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: Object.keys(merged).length > 0 ? merged : undefined,
    cwd: config.cwd || undefined,
  })
}

/**
 * Conecta um servidor. Com `interactive` (reconnect manual / botão
 * Autorizar), um 401 por OAuth abre o navegador e espera o code no
 * loopback; sem `interactive` (startup), o servidor vai para o estado
 * "unauthorized" e a UI oferece o botão Autorizar.
 */
async function connect(runtime: ServerRuntime, interactive = false): Promise<void> {
  runtime.state = 'connecting'
  runtime.error = undefined
  runtime.lastAttempt = Date.now()
  const url = oauthUrl(runtime.config)
  try {
    let client = new Client({ name: 'orbit', version: '0.1.0' })
    if (url) {
      await ensureOAuthLoopback()
      runtime.authorized = await hasOAuthTokens(url)
      setOAuthInteractive(url, interactive)
    }
    let transport = await buildTransport(runtime.config)
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, runtime.config.name)
    } catch (err) {
      if (!(err instanceof UnauthorizedError) || !url) throw err
      // Servidor exige OAuth: aguarda o code vindo do loopback (fluxo
      // interativo) ou sinaliza "unauthorized" para a UI (fluxo automático).
      const code = await awaitPendingAuth(url)
      if (!code) {
        runtime.state = 'unauthorized'
        return
      }
      if (!(transport instanceof StreamableHTTPClientTransport)) throw err
      await transport.finishAuth(code)
      // O par client/transport da tentativa anterior já foi iniciado (e
      // fechado no erro) — o SDK recusa reiniciar o mesmo transport. Com o
      // token salvo pelo finishAuth, a conexão vai em instâncias novas.
      await transport.close().catch(() => {})
      client = new Client({ name: 'orbit', version: '0.1.0' })
      transport = await buildTransport(runtime.config)
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, runtime.config.name)
    }
    const { tools: discovered } = await withTimeout(
      client.listTools(),
      CONNECT_TIMEOUT_MS,
      runtime.config.name,
    )

    const toolSet: ToolSet = {}
    const prefix = sanitizeName(runtime.config.name)
    for (const mcpTool of discovered) {
      toolSet[`${prefix}_${sanitizeName(mcpTool.name)}`] = tool({
        description: `[MCP ${runtime.config.name}] ${mcpTool.description ?? mcpTool.name}`,
        inputSchema: jsonSchema((mcpTool.inputSchema ?? { type: 'object' }) as Record<string, unknown>),
        execute: async (input) => {
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: (input ?? {}) as Record<string, unknown>,
          })
          return contentToText(result)
        },
      })
    }

    runtime.client = client
    runtime.tools = toolSet
    runtime.state = 'connected'
    runtime.retryCount = 0
    if (url) runtime.authorized = await hasOAuthTokens(url)
  } catch (err) {
    runtime.client = null
    runtime.tools = {}
    runtime.retryCount++
    runtime.error =
      describeOAuthError(err, Boolean(runtime.config.oauth?.clientId?.trim())) ??
      (err instanceof Error ? err.message : String(err))
    // Falha de autorização num servidor OAuth que nunca autorizou: vira
    // "unauthorized" (a UI oferece Autorizar) em vez de "error" — assim o
    // watcher não fica repetindo um fluxo que só o usuário destrava.
    runtime.state = url && !runtime.authorized && isAuthFailure(err) ? 'unauthorized' : 'error'
  } finally {
    if (url) setOAuthInteractive(url, false)
  }
}

/** Erro que só o usuário resolve autorizando (401/403, OAuth, registro recusado). */
function isAuthFailure(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /oauth|unauthorized|invalid_client|invalid_grant|HTTP (401|403)/i.test(message)
}

async function disconnect(runtime: ServerRuntime): Promise<void> {
  try {
    await runtime.client?.close()
  } catch {
    // já caiu
  }
  runtime.client = null
  runtime.tools = {}
  if (runtime.config.type === 'http' && runtime.config.url) {
    cancelPendingAuth(runtime.config.url)
  }
}

/** Conecta todos os servidores habilitados da config (chamado no startup). */
export async function initMcp(): Promise<void> {
  const config = await readMcpConfig()
  await reconcile(config)
  startReconnectWatcher()
}

/** Desconecta tudo e para o watcher (chamado no shutdown). */
export async function shutdownMcp(): Promise<void> {
  stopReconnectWatcher()
  await Promise.all([...servers.values()].map(disconnect))
  servers.clear()
  closeOAuthLoopback()
}

/** Sincroniza runtimes com a config: remove, atualiza e conecta o necessário. */
async function reconcile(config: McpConfig): Promise<void> {
  const wanted = new Map(config.servers.map((s) => [s.name, s]))
  for (const [name, runtime] of servers) {
    if (!wanted.has(name)) {
      await disconnect(runtime)
      servers.delete(name)
    }
  }
  await Promise.all(
    [...wanted.values()].map(async (serverConfig) => {
      const existing = servers.get(serverConfig.name)
      const changed = existing && JSON.stringify(existing.config) !== JSON.stringify(serverConfig)
      if (existing && !changed) return
      if (existing) await disconnect(existing)
      const url = oauthUrl(serverConfig)
      const runtime: ServerRuntime = {
        config: serverConfig,
        client: null,
        tools: {},
        state: 'disabled',
        lastAttempt: 0,
        retryCount: 0,
        authorized: url ? await hasOAuthTokens(url) : undefined,
      }
      servers.set(serverConfig.name, runtime)
      if (serverConfig.enabled !== false) await connect(runtime)
    }),
  )
}

/** Persiste a config e reconcilia as conexões. */
export async function saveMcpConfig(config: McpConfig): Promise<McpServerStatus[]> {
  await writeMcpConfig(config)
  await reconcile(config)
  return listMcpStatus()
}

/**
 * Reconecta sem abrir o navegador: um servidor OAuth sem token vai para
 * "unauthorized" e a UI oferece o botão Autorizar. Botão Reconectar da UI.
 */
export async function reconnectMcp(name?: string, interactive = false): Promise<McpServerStatus[]> {
  for (const runtime of servers.values()) {
    if (name && runtime.config.name !== name) continue
    if (runtime.config.enabled === false) continue
    await disconnect(runtime)
    await connect(runtime, interactive)
  }
  return listMcpStatus()
}

/**
 * Inicia o fluxo OAuth interativo (abre o navegador) — botão Autorizar da UI.
 * Quando o servidor nunca foi autorizado, descarta um registro dinâmico
 * incompleto de tentativas anteriores para o fluxo começar limpo; tokens
 * válidos (só precisando de refresh) são preservados.
 */
export async function authorizeMcp(name: string): Promise<McpServerStatus[]> {
  const runtime = servers.get(name)
  if (!runtime) return listMcpStatus()
  const url = oauthUrl(runtime.config)
  if (url && !(await hasOAuthTokens(url))) await forgetOAuth(url)
  return reconnectMcp(name, true)
}

/** redirect_uri do loopback OAuth (para cadastrar no app do provedor). */
export { oauthRedirectUrl }

export function listMcpStatus(): McpServerStatus[] {
  return [...servers.values()].map((runtime) => ({
    config: runtime.config,
    state: runtime.config.enabled === false ? 'disabled' : runtime.state,
    error: runtime.error,
    toolNames: Object.keys(runtime.tools),
    usesOAuth: Boolean(oauthUrl(runtime.config)),
    authorized: runtime.authorized ?? false,
  }))
}

/** ToolSet mesclado dos servidores conectados (síncrono — cache do manager). */
export function getMcpTools(): ToolSet {
  const merged: ToolSet = {}
  for (const runtime of servers.values()) {
    if (runtime.config.enabled === false) continue
    if (runtime.state === 'connected') {
      Object.assign(merged, runtime.tools)
    }
  }
  return merged
}

/** Nomes de servidores utilizáveis (para a paleta "/" citar @mcp:<nome>). */
export function listMcpServerNames(): string[] {
  return [...servers.values()]
    .filter((r) => r.config.enabled !== false && r.state === 'connected')
    .map((r) => r.config.name)
}

/** Descrição formatada dos servidores MCP conectados e suas ferramentas. */
export function listMcpToolDescriptions(): string {
  const lines: string[] = []
  for (const runtime of servers.values()) {
    if (runtime.config.enabled === false || runtime.state !== 'connected') continue
    const names = Object.keys(runtime.tools)
    lines.push(`- @mcp:${runtime.config.name}: ${names.join(', ')}`)
  }
  return lines.join('\n')
}

/** Retorna o PermissionMode override do servidor MCP para uma tool, se configurado. */
export function getMcpPermissionMode(toolName: string): PermissionMode | undefined {
  const idx = toolName.indexOf('_')
  if (idx <= 0) return undefined
  const serverName = toolName.slice(0, idx)
  return servers.get(serverName)?.config.permissionMode
}

/* ------------------------------------------------------------------ */
/*  Background reconnect watcher                                        */
/* ------------------------------------------------------------------ */

function nextBackoff(runtime: ServerRuntime): number {
  if (runtime.retryCount <= 0) return RECONNECT_BASE_MS
  const delay = RECONNECT_BASE_MS * Math.pow(2, runtime.retryCount)
  return Math.min(delay, RECONNECT_MAX_MS)
}

let reconnectTimer: ReturnType<typeof setInterval> | null = null

function startReconnectWatcher(): void {
  if (reconnectTimer) return
  reconnectTimer = setInterval(() => {
    for (const runtime of servers.values()) {
      if (runtime.config.enabled === false) continue
      if (runtime.config.autoReconnect === false) continue
      if (runtime.state !== 'error') continue
      if (Date.now() - runtime.lastAttempt < nextBackoff(runtime)) continue
      void connect(runtime)
    }
  }, RECONNECT_INTERVAL_MS)
}

function stopReconnectWatcher(): void {
  if (reconnectTimer) {
    clearInterval(reconnectTimer)
    reconnectTimer = null
  }
}
