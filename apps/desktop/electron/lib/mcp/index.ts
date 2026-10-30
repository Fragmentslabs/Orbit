import { app } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { jsonSchema, tool, type ToolSet } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { McpConfig, McpServerConfig, McpServerStatus } from '@shared/mcp'
import type { PermissionMode } from '@shared/chat'
import { dataDir } from '../storage'
import { saveMedia } from '../media'
import { mcpResultToText, type SavedImage } from './result'
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
import { attachSamplingHandler, samplingCapabilities } from './sampling'
import { descriptionsState, optimizedFor, optimizeServerDescriptions } from './describe'

/**
 * MCP manager: connects the servers of mcp-config.json (stdio/streamable HTTP),
 * discovers the tools via tools/list and exposes them as an ai-sdk ToolSet with
 * prefixed names (<server>_<tool>). getMcpTools() is synchronous (the manager's list)
 * so that it fits into buildToolSet. Servers with an error try to reconnect in the
 * background with exponential backoff.
 */

const CONNECT_TIMEOUT_MS = 15_000
const RECONNECT_BASE_MS = 15_000
const RECONNECT_MAX_MS = 300_000 // 5 minutes
const RECONNECT_INTERVAL_MS = 10_000 // checked every 10 s

interface ServerRuntime {
  config: McpServerConfig
  client: Client | null
  /** Tools discovered in tools/list, already with the prefixed name. The ToolSet
   *  is built per turn in getMcpTools: the result depends on the session (where to
   *  store the images) and on what the turn offers (show_image, describe_image). */
  tools: McpToolDef[]
  state: McpServerStatus['state']
  error?: string
  lastAttempt: number
  retryCount: number
  /** http with OAuth: a token is already saved (authorized at some point on this device) */
  authorized?: boolean
  /** Failure of the last automatic re-listing (notifications/tools/list_changed).
   *  Separate from `error`: the connection is still valid and the previous list stays
   *  in use — this is a warning, not a server that is down. */
  toolListError?: string
  /** Re-listings in series: a burst of notifications cannot apply the results out of
   *  order (the old list overwriting the new one). */
  toolListQueue?: Promise<void>
}

interface McpToolDef {
  name: string
  mcpName: string
  description?: string
  inputSchema?: unknown
}

/** What the turn offers to the result of an MCP tool. */
export interface McpToolScope {
  sessionId: string
  canShow: boolean
  canDescribe: boolean
  /**
   * Slice of servers chosen in the conversation (names). Absent = all the ones
   * enabled in the app; empty = none.
   */
  only?: string[]
}

/** Does the server take part in this turn? Turned off in the app or outside the conversation's slice. */
function inScope(runtime: ServerRuntime, only?: string[]): boolean {
  if (runtime.config.enabled === false) return false
  return !only || only.includes(runtime.config.name)
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

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** Stores the image of an MCP result in the conversation's gallery. Formats outside
 *  the list become PNG — the gallery and describe_image only speak the common ones. */
async function saveMcpImage(
  data: Buffer,
  mimeType: string,
  sessionId: string,
  name: string,
): Promise<SavedImage | null> {
  let buffer = data
  let ext = MIME_EXT[mimeType.toLowerCase()]
  if (!ext) {
    buffer = await sharp(data).png().toBuffer()
    ext = 'png'
  }
  const meta = await sharp(buffer).metadata().catch(() => null)
  // 'script': intermediate automation material — it goes into the gallery's quick
  // cleanup while it is not shown in any message.
  const url = await saveMedia(buffer, ext, { source: 'script', sessionId, name })
  return { url, width: meta?.width, height: meta?.height, bytes: buffer.length }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: timeout after ${ms / 1000}s`)), ms),
    ),
  ])
}

/**
 * URL of the server when it authenticates via OAuth — or undefined.
 *
 * Its own Authorization header turns OAuth off (otherwise a 401 for an invalid key
 * would turn into an unrequested authorization flow); other headers (API version,
 * tenant…) live fine with OAuth.
 */
function oauthUrl(config: McpServerConfig): string | undefined {
  if (config.type !== 'http' || !config.url) return undefined
  const hasAuthHeader = Object.entries(config.headers ?? {}).some(
    ([key, value]) => key.trim().toLowerCase() === 'authorization' && value,
  )
  return hasAuthHeader ? undefined : config.url
}

/**
 * Builds the server's transport. For HTTP, an OAuth authProvider is attached
 * according to oauthUrl(). On a 401, the SDK calls redirectToAuthorization and throws
 * UnauthorizedError — connect handles it.
 */
async function buildTransport(config: McpServerConfig) {
  if (config.type === 'http') {
    if (!config.url) throw new Error('http server with no url')
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
  if (!config.command) throw new Error('stdio server with no command')
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
 * Connects a server. With `interactive` (manual reconnect / Authorize button), a 401
 * for OAuth opens the browser and waits for the code on the loopback; without
 * `interactive` (startup), the server goes to the "unauthorized" state and the UI
 * offers the Authorize button.
 */
async function connect(runtime: ServerRuntime, interactive = false): Promise<void> {
  runtime.state = 'connecting'
  runtime.error = undefined
  runtime.toolListError = undefined
  runtime.toolListQueue = undefined
  runtime.lastAttempt = Date.now()
  const url = oauthUrl(runtime.config)
  try {
    let client = createClient(runtime.config.name)
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
      // Server requires OAuth: it waits for the code coming from the loopback (interactive
      // flow) or signals "unauthorized" to the UI (automatic flow).
      const code = await awaitPendingAuth(url)
      if (!code) {
        runtime.state = 'unauthorized'
        return
      }
      if (!(transport instanceof StreamableHTTPClientTransport)) throw err
      await transport.finishAuth(code)
      // The client/transport pair of the previous attempt was already started (and closed
      // on the error) — the SDK refuses to restart the same transport. With the token saved
      // by finishAuth, the connection goes in new instances.
      await transport.close().catch(() => {})
      client = createClient(runtime.config.name)
      transport = await buildTransport(runtime.config)
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, runtime.config.name)
    }
    const { tools: discovered } = await withTimeout(
      client.listTools(),
      CONNECT_TIMEOUT_MS,
      runtime.config.name,
    )

    const prefix = sanitizeName(runtime.config.name)
    runtime.client = client
    runtime.tools = toToolDefs(prefix, discovered)
    runtime.state = 'connected'
    runtime.retryCount = 0
    if (url) runtime.authorized = await hasOAuthTokens(url)
    // The list may change with the connection up (a server that loads tools on demand, a
    // reloaded plugin). The handler uses THIS client and THIS runtime.
    watchToolList(runtime, client)
  } catch (err) {
    runtime.client = null
    runtime.tools = []
    runtime.retryCount++
    runtime.error =
      describeOAuthError(err, Boolean(runtime.config.oauth?.clientId?.trim())) ??
      (err instanceof Error ? err.message : String(err))
    // Authorization failure in an OAuth server that never authorized: it becomes
    // "unauthorized" (the UI offers Authorize) instead of "error" — that way the watcher
    // does not keep repeating a flow that only the user can unlock.
    runtime.state = url && !runtime.authorized && isAuthFailure(err) ? 'unauthorized' : 'error'
  } finally {
    if (url) setOAuthInteractive(url, false)
  }
}

/** Error that only the user solves by authorizing (401/403, OAuth, refused registration). */
function isAuthFailure(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /oauth|unauthorized|invalid_client|invalid_grant|HTTP (401|403)/i.test(message)
}

/** Tool as tools/list returns it — only what the manager consumes. */
interface DiscoveredTool {
  name: string
  description?: string
  inputSchema?: unknown
}

/** Converts the tools/list result into manager definitions, with the prefixed name
 *  (`<prefix>_<tool>`). The prefix already comes sanitized. */
function toToolDefs(prefix: string, discovered: DiscoveredTool[]): McpToolDef[] {
  return discovered.map((mcpTool) => ({
    name: `${prefix}_${sanitizeName(mcpTool.name)}`,
    mcpName: mcpTool.name,
    description: mcpTool.description,
    inputSchema: mcpTool.inputSchema,
  }))
}

/**
 * Listens to the connected server's `notifications/tools/list_changed`.
 *
 * Without it, a server that changes its own tool list would only be noticed on the
 * next connect, and the turn's toolset would go out of date (new tool invisible,
 * removed tool still offered).
 *
 * The connection is NOT redone: `runtime` and `client` stay the same and only
 * `runtime.tools` is swapped in place — the "connected" state and the client in use by
 * the ToolSet remain valid.
 */
function watchToolList(runtime: ServerRuntime, client: Client): void {
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    const next = (runtime.toolListQueue ?? Promise.resolve()).then(() =>
      refreshToolList(runtime, client),
    )
    // The re-listing already handles its own errors; the catch is only the safety net so
    // that the queue is never rejected (nor becomes unhandled).
    runtime.toolListQueue = next.catch(() => {})
    return runtime.toolListQueue
  })
}

/** Re-lists the tools and replaces `runtime.tools` in place. It never throws. */
async function refreshToolList(runtime: ServerRuntime, client: Client): Promise<void> {
  // Connection swapped/closed while the notification was arriving: this re-listing
  // belongs to a dead client and the result would overwrite the current list.
  if (runtime.client !== client) return
  try {
    const { tools: discovered } = await withTimeout(
      client.listTools(),
      CONNECT_TIMEOUT_MS,
      runtime.config.name,
    )
    if (runtime.client !== client) return
    runtime.tools = toToolDefs(sanitizeName(runtime.config.name), discovered)
    runtime.toolListError = undefined
  } catch (err) {
    // Transient failure (timeout, busy server, dropped HTTP session): the previous list
    // stays valid — clearing it here would take from the model all the tools of a server
    // that is still connected.
    runtime.toolListError = err instanceof Error ? err.message : String(err)
    console.warn(
      `[mcp:${runtime.config.name}] failed to re-list tools after tools/list_changed:`,
      runtime.toolListError,
    )
  }
}

async function disconnect(runtime: ServerRuntime): Promise<void> {
  try {
    await runtime.client?.close()
  } catch {
    // it already went down
  }
  runtime.client = null
  runtime.tools = []
  if (runtime.config.type === 'http' && runtime.config.url) {
    cancelPendingAuth(runtime.config.url)
  }
}

/** Connects every enabled server of the config (called at startup). */
export async function initMcp(): Promise<void> {
  const config = await readMcpConfig()
  await reconcile(config)
  startReconnectWatcher()
}

/** Disconnects everything and stops the watcher (called at shutdown). */
export async function shutdownMcp(): Promise<void> {
  stopReconnectWatcher()
  await Promise.all([...servers.values()].map(disconnect))
  servers.clear()
  closeOAuthLoopback()
}

/** Syncs runtimes with the config: removes, updates and connects what is needed. */
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
        tools: [],
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

/** Persists the config and reconciles the connections. */
export async function saveMcpConfig(config: McpConfig): Promise<McpServerStatus[]> {
  await writeMcpConfig(config)
  await reconcile(config)
  return listMcpStatus()
}

/**
 * Reconnects without opening the browser: an OAuth server without a token goes to
 * "unauthorized" and the UI offers the Authorize button. The UI's Reconnect button.
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
 * Starts the interactive OAuth flow (opens the browser) — the UI's Authorize button.
 * When the server was never authorized, it discards an incomplete dynamic registration
 * from previous attempts so the flow starts clean; valid tokens (only needing a
 * refresh) are preserved.
 */
export async function authorizeMcp(name: string): Promise<McpServerStatus[]> {
  const runtime = servers.get(name)
  if (!runtime) return listMcpStatus()
  const url = oauthUrl(runtime.config)
  if (url && !(await hasOAuthTokens(url))) await forgetOAuth(url)
  return reconnectMcp(name, true)
}

/** redirect_uri of the OAuth loopback (to register in the provider's app). */
export { oauthRedirectUrl }

export function listMcpStatus(): McpServerStatus[] {
  return [...servers.values()].map((runtime) => ({
    config: runtime.config,
    state: runtime.config.enabled === false ? 'disabled' : runtime.state,
    error: runtime.error,
    toolNames: runtime.tools.map((t) => t.name),
    usesOAuth: Boolean(oauthUrl(runtime.config)),
    authorized: runtime.authorized ?? false,
  }))
}

/**
 * Orbit's MCP client.
 *
 * The `sampling` capability is deliberate: it is what lets a connected app ask for a
 * model response from here — the "reverse MCP" (see sampling.ts). Without it the app's
 * `sampling/createMessage` would get "method not found", because a common MCP client
 * only TALKS to the server, it never answers it.
 */
function createClient(serverName: string): Client {
  const client = new Client(
    { name: 'orbit', version: app.getVersion() },
    { capabilities: samplingCapabilities() },
  )
  attachSamplingHandler(client, serverName)
  return client
}

/** Merged ToolSet of the connected servers (synchronous — the manager's list). */
export function getMcpTools(scope: McpToolScope): ToolSet {
  const merged: ToolSet = {}
  for (const runtime of servers.values()) {
    if (!inScope(runtime, scope.only)) continue
    if (runtime.state !== 'connected' || !runtime.client) continue
    const client = runtime.client
    // A rewritten description (the "Optimize" button) only holds while the tool list
    // does not change: a new tool has to come back with the server's own text.
    const rewritten = optimizedFor(runtime.config.name, runtime.tools)
    for (const def of runtime.tools) {
      merged[def.name] = tool({
        description: `[MCP ${runtime.config.name}] ${rewritten?.[def.mcpName] ?? def.description ?? def.mcpName}`,
        inputSchema: jsonSchema((def.inputSchema ?? { type: 'object' }) as Record<string, unknown>),
        execute: async (input) => {
          const result = await client.callTool({
            name: def.mcpName,
            arguments: (input ?? {}) as Record<string, unknown>,
          })
          return mcpResultToText(result, {
            saveImage: (data, mimeType) => saveMcpImage(data, mimeType, scope.sessionId, def.name),
            canShow: scope.canShow,
            canDescribe: scope.canDescribe,
          })
        },
      })
    }
  }
  return merged
}

function findServer(name: string): ServerRuntime | undefined {
  return [...servers.values()].find((runtime) => runtime.config.name === name)
}

/** State of the description optimization, for the server's card. */
export function mcpDescriptionsState(name: string): {
  optimized: boolean
  count: number
  at?: string
  modelId?: string
  tools: number
} {
  const runtime = findServer(name)
  if (!runtime) return { optimized: false, count: 0, tools: 0 }
  return { ...descriptionsState(name, runtime.tools), tools: runtime.tools.length }
}

/**
 * The card's "Optimize" button: rewrites the server's descriptions with the auxiliary
 * model and stores the result. It is not called per turn — only on click.
 */
export async function optimizeMcpServer(name: string) {
  const runtime = findServer(name)
  if (!runtime) throw new Error('MCP server not found')
  if (runtime.state !== 'connected') throw new Error('MCP server is not connected')
  const result = await optimizeServerDescriptions(
    name,
    runtime.tools.map((t) => ({ name: t.mcpName, description: t.description })),
  )
  return { ...result, tools: runtime.tools.length }
}

/** Usable server names (for the "/" palette to cite @mcp:<name>). */
export function listMcpServerNames(): string[] {
  return [...servers.values()]
    .filter((r) => r.config.enabled !== false && r.state === 'connected')
    .map((r) => r.config.name)
}

/**
 * Formatted description of the connected MCP servers and their tools.
 * `only` mirrors the conversation's slice: the prompt must not list a server whose tool
 * was not exposed in this turn.
 */
export function listMcpToolDescriptions(only?: string[]): string {
  const lines: string[] = []
  for (const runtime of servers.values()) {
    if (!inScope(runtime, only) || runtime.state !== 'connected') continue
    const names = runtime.tools.map((t) => t.name)
    lines.push(`- @mcp:${runtime.config.name}: ${names.join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * SANITIZED prefixes of the connected servers — the key that turns `<prefix>_<tool>`
 * into an MCP family in the on-demand tool catalog.
 *
 * It has to be the same `sanitizeName` used when building the tool name (`:247`): the
 * server name may have a space, the prefix may not.
 */
export function listMcpServerPrefixes(): string[] {
  return [...servers.values()]
    .filter((runtime) => runtime.state === 'connected' && runtime.tools.length > 0)
    .map((runtime) => sanitizeName(runtime.config.name))
}

/**
 * Enabled servers that did NOT come up, with the reason. The catalog shows them as an
 * empty, disabled family: without that, a server that fails to connect disappears from
 * the map, and a server that vanished is indistinguishable from one that never existed
 * — the model concludes the capability does not exist instead of saying what happened.
 */
export function listUnavailableMcpServers(): { prefix: string; reason: string }[] {
  return [...servers.values()]
    .filter((runtime) => runtime.config.enabled !== false && runtime.state === 'error')
    .map((runtime) => ({
      prefix: sanitizeName(runtime.config.name),
      reason: runtime.error || 'unknown error',
    }))
}

/** Returns the MCP server's PermissionMode override for a tool, if configured. */
export function getMcpPermissionMode(toolName: string): PermissionMode | undefined {
  const idx = toolName.indexOf('_')
  if (idx <= 0) return undefined
  const serverName = toolName.slice(0, idx)
  return servers.get(serverName)?.config.permissionMode
}

/**
 * Is the prefix of this name a REALLY configured MCP server?
 *
 * It is the check permission/rules.ts was missing: there, any tool with "_" was taken
 * as MCP, so `motion_preview`, `audio_generate`, `pdf_merge` and company asked for
 * permission as "Tool of the MCP server motion". The name only means "server" if a
 * server with that name exists.
 */
export function isMcpServerName(name: string): boolean {
  return servers.has(name)
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
