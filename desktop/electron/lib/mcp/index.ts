import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { jsonSchema, tool, type ToolSet } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { McpConfig, McpServerConfig, McpServerStatus } from '@shared/mcp'
import { dataDir } from '../storage'

/**
 * Manager MCP: conecta os servidores do mcp-config.json (stdio/streamable
 * HTTP), descobre as ferramentas via tools/list e as expõe como ToolSet do
 * ai-sdk com nomes prefixados (<servidor>_<tool>). getMcpTools() é síncrono
 * (cache do manager) para encaixar no buildToolSet; servidores com erro
 * tentam reconectar de forma throttled a cada uso.
 */

const CONNECT_TIMEOUT_MS = 15_000
const RECONNECT_THROTTLE_MS = 30_000

interface ServerRuntime {
  config: McpServerConfig
  client: Client | null
  tools: ToolSet
  state: McpServerStatus['state']
  error?: string
  lastAttempt: number
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
    return new StreamableHTTPClientTransport(new URL(config.url))
  }
  if (!config.command) throw new Error('servidor stdio sem command')
  return new StdioClientTransport({ command: config.command, args: config.args ?? [] })
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
  } catch (err) {
    runtime.client = null
    runtime.tools = {}
    runtime.state = 'error'
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
    } else if (runtime.state === 'error' && Date.now() - runtime.lastAttempt > RECONNECT_THROTTLE_MS) {
      // Reconexão automática em background, throttled — as tools entram no próximo turno
      void connect(runtime)
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
