import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { jsonSchema, tool, type ToolSet } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { McpConfig, McpServerConfig, McpServerStatus } from '@shared/mcp'
import type { PermissionMode } from '@shared/chat'
import { dataDir } from '../storage'

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

function buildTransport(config: McpServerConfig) {
  if (config.type === 'http') {
    if (!config.url) throw new Error('servidor http sem url')
    const headers: Record<string, string> = {}
    if (config.headers) {
      for (const [k, v] of Object.entries(config.headers)) {
        if (k.trim() && v) headers[k.trim()] = v
      }
    }
    return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
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

async function connect(runtime: ServerRuntime): Promise<void> {
  runtime.state = 'connecting'
  runtime.error = undefined
  runtime.lastAttempt = Date.now()
  try {
    const client = new Client({ name: 'orbit', version: '0.1.0' })
    await withTimeout(client.connect(buildTransport(runtime.config)), CONNECT_TIMEOUT_MS, runtime.config.name)
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
  } catch (err) {
    runtime.client = null
    runtime.tools = {}
    runtime.state = 'error'
    runtime.retryCount++
    runtime.error = err instanceof Error ? err.message : String(err)
  }
}

async function disconnect(runtime: ServerRuntime): Promise<void> {
  try {
    await runtime.client?.close()
  } catch {
    // já caiu
  }
  runtime.client = null
  runtime.tools = {}
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
      const runtime: ServerRuntime = {
        config: serverConfig,
        client: null,
        tools: {},
        state: 'disabled',
        lastAttempt: 0,
        retryCount: 0,
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

export async function reconnectMcp(name?: string): Promise<McpServerStatus[]> {
  for (const runtime of servers.values()) {
    if (name && runtime.config.name !== name) continue
    if (runtime.config.enabled === false) continue
    await disconnect(runtime)
    await connect(runtime)
  }
  return listMcpStatus()
}

export function listMcpStatus(): McpServerStatus[] {
  return [...servers.values()].map((runtime) => ({
    config: runtime.config,
    state: runtime.config.enabled === false ? 'disabled' : runtime.state,
    error: runtime.error,
    toolNames: Object.keys(runtime.tools),
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
