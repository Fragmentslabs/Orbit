import fsp from 'node:fs/promises'
import { watchFile, unwatchFile } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpServerConfig } from '@shared/mcp'
import type { NodaraStatus } from '@shared/nodara'
import { listMcpStatus, readMcpConfig, reconnectMcp, saveMcpConfig } from './mcp'

/**
 * Official integration with Nodara (Android device control over MCP).
 *
 * Nodara publishes a "bridge file" at ~/.nodara/mcp.json with the URL of its
 * local MCP server and the access token. Here we read that file,
 * check whether the app is up (/health) and register/update the "Nodara"
 * server in Orbit's mcp-config.json — that is what makes the tools show up
 * for the agent.
 *
 * Two points that the first version got wrong and are now handled:
 *  - The displayed state came only from Nodara's /health. The app could be running
 *    (= "connected") with no MCP entry in Orbit, so the agent had
 *    no tool at all. Now the state combines both ends.
 *  - Nodara's token may be regenerated (and the port changed). The entry
 *    saved in Orbit kept the old token and every request came back 401. A
 *    watcher on the bridge file keeps the credential up to date.
 */

const BRIDGE_PATH = path.join(os.homedir(), '.nodara', 'mcp.json')
const HEALTH_TIMEOUT_MS = 2_500
const BRIDGE_WATCH_INTERVAL_MS = 10_000

export const NODARA_SERVER_NAME = 'Nodara'

interface NodaraBridge {
  enabled?: boolean
  status?: string
  baseUrl?: string
  apiUrl?: string
  mcpUrl?: string
  token?: string
}

async function readBridge(): Promise<NodaraBridge | null> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(BRIDGE_PATH, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as NodaraBridge
  } catch {
    return null
  }
}

/** Checks whether Nodara's local server is up (the /health is public). */
async function probeHealth(mcpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${new URL(mcpUrl).origin}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const health = (await response.json()) as { app?: string; ok?: boolean }
    return health.app === 'Nodara' && health.ok === true
  } catch {
    return false
  }
}

function authHeader(token: string): Record<string, string> {
  // Nodara accepts Bearer, X-Nodara-Token or ?token=. Header is preferable:
  // it keeps the token out of the URL displayed in the card and in the MCP server list.
  return { Authorization: `Bearer ${token}` }
}

/** Nodara's MCP entry, preserving the user's preferences when editing. */
function buildEntry(bridge: NodaraBridge, existing?: McpServerConfig): McpServerConfig {
  const headers = { ...(existing?.headers ?? {}) }
  delete headers.Authorization
  delete headers.authorization
  delete headers['X-Nodara-Token']
  return {
    ...(existing ?? {}),
    name: NODARA_SERVER_NAME,
    type: 'http',
    url: bridge.mcpUrl,
    enabled: true,
    autoReconnect: existing?.autoReconnect ?? true,
    headers: { ...headers, ...(bridge.token ? authHeader(bridge.token) : {}) },
  }
}

function findEntry(servers: McpServerConfig[]): McpServerConfig | undefined {
  return servers.find((server) => server.name === NODARA_SERVER_NAME)
}

/** Does the saved entry match what Nodara is publishing right now? */
function entryMatchesBridge(entry: McpServerConfig, bridge: NodaraBridge): boolean {
  if (entry.url !== bridge.mcpUrl) return false
  const current = entry.headers?.Authorization ?? entry.headers?.authorization
  return current === (bridge.token ? `Bearer ${bridge.token}` : undefined)
}

/**
 * Translates the transport's raw error into an actionable code. A 401 from Nodara
 * arrives as "Streamable HTTP error: Error POSTing to endpoint: {"error":
 * "Unauthorized"}" — useless to whoever only wants to know that they need to reconnect.
 */
function normalizeError(error?: string): string | undefined {
  if (!error) return undefined
  if (/unauthorized|\b401\b|forbidden|\b403\b/i.test(error)) return 'nodara-unauthorized'
  if (/ECONNREFUSED|fetch failed|timeout/i.test(error)) return 'nodara-unreachable'
  return error
}

/**
 * State of the integration: crosses the bridge file + Nodara's /health with what
 * Orbit actually has registered and connected.
 */
export async function discoverNodara(): Promise<NodaraStatus> {
  const bridge = await readBridge()
  const config = await readMcpConfig()
  const entry = findEntry(config.servers)
  const runtime = listMcpStatus().find((s) => s.config.name === NODARA_SERVER_NAME)

  const linked = !!entry
  const base = {
    linked,
    mcpUrl: bridge?.mcpUrl ?? entry?.url,
    toolCount: runtime?.toolNames.length ?? 0,
    error: normalizeError(runtime?.error),
  }

  if (!bridge) {
    // No bridge file: either Nodara never ran, or it was uninstalled. If
    // Orbit has the entry and it is connected, what counts is the live connection.
    if (linked && runtime?.state === 'connected') return { ...base, state: 'connected', tokenStale: false }
    return { ...base, state: 'not-installed', tokenStale: false }
  }

  const running = !!bridge.mcpUrl && (await probeHealth(bridge.mcpUrl))
  const tokenStale = linked && !!entry && !entryMatchesBridge(entry, bridge)

  if (!running) {
    // "disabled" is the bridge turned off in Nodara's settings: reconnecting
    // does not solve it, the user is the one who has to act there.
    return { ...base, state: bridge.enabled === false ? 'disabled' : 'stopped', tokenStale }
  }
  if (!linked) return { ...base, state: 'installed', tokenStale: false }
  if (runtime?.state === 'connected') return { ...base, state: 'connected', tokenStale }
  // An entry disabled in Orbit is not a failure: the Connect button reactivates it.
  return { ...base, state: entry?.enabled === false ? 'installed' : 'error', tokenStale }
}

/**
 * Registers (or repairs) Nodara's MCP server and connects. Returns the post-connection
 * state so the card reflects the real result, not the intention.
 */
export async function connectNodara(): Promise<NodaraStatus> {
  const bridge = await readBridge()
  if (!bridge?.mcpUrl) return { ...(await discoverNodara()), error: 'nodara-not-found' }
  if (!bridge.token) return { ...(await discoverNodara()), error: 'nodara-no-token' }
  if (!(await probeHealth(bridge.mcpUrl))) {
    return { ...(await discoverNodara()), error: 'nodara-not-running' }
  }

  const config = await readMcpConfig()
  const existing = findEntry(config.servers)
  const entry = buildEntry(bridge, existing)
  const index = config.servers.findIndex((server) => server.name === NODARA_SERVER_NAME)
  if (index >= 0) config.servers[index] = entry
  else config.servers.push(entry)

  await saveMcpConfig(config)
  // saveMcpConfig only reconnects what changed; if the entry was identical and was
  // in error, it forces the new attempt here — the click has to count for something.
  const status = listMcpStatus().find((s) => s.config.name === NODARA_SERVER_NAME)
  if (status && status.state !== 'connected') await reconnectMcp(NODARA_SERVER_NAME)

  return discoverNodara()
}

/** Removes Nodara from the MCP servers (the app itself keeps running). */
export async function disconnectNodara(): Promise<NodaraStatus> {
  const config = await readMcpConfig()
  const servers = config.servers.filter((server) => server.name !== NODARA_SERVER_NAME)
  if (servers.length !== config.servers.length) await saveMcpConfig({ servers })
  return discoverNodara()
}

/**
 * Keeps the saved credential equal to the one in the bridge file. It only acts when the user
 * has already connected Nodara at some point — it never registers on its own.
 */
export async function syncNodaraCredentials(): Promise<boolean> {
  const bridge = await readBridge()
  if (!bridge?.mcpUrl || !bridge.token) return false

  const config = await readMcpConfig()
  const existing = findEntry(config.servers)
  if (!existing || entryMatchesBridge(existing, bridge)) return false

  const index = config.servers.findIndex((server) => server.name === NODARA_SERVER_NAME)
  config.servers[index] = buildEntry(bridge, existing)
  await saveMcpConfig(config)
  return true
}

let watching = false

/**
 * Watches ~/.nodara/mcp.json: when Nodara restarts on another port or the
 * token is regenerated, Orbit's entry updates itself instead of getting
 * 401s. watchFile (stat polling) because the file is rewritten whole
 * by Nodara and may not even exist yet when Orbit starts.
 */
export function watchNodaraBridge(): void {
  if (watching) return
  watching = true
  void syncNodaraCredentials()
  watchFile(BRIDGE_PATH, { interval: BRIDGE_WATCH_INTERVAL_MS }, () => {
    void syncNodaraCredentials()
  })
}

export function stopWatchingNodaraBridge(): void {
  if (!watching) return
  unwatchFile(BRIDGE_PATH)
  watching = false
}
