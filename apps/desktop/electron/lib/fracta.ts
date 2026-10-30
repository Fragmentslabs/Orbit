import fsp from 'node:fs/promises'
import { watchFile, unwatchFile } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpServerConfig } from '@shared/mcp'
import type { FractaStatus } from '@shared/fracta'
import { listMcpStatus, readMcpConfig, reconnectMcp, saveMcpConfig } from './mcp'

/**
 * Official integration with Fracta (databases over MCP).
 *
 * Fracta keeps its MCP server settings in mcp.json, in the app's data
 * folder: whether it is on, the access token and the URL the backend
 * is listening on. It is the same file that Fracta's own STDIO bridge reads.
 * Here we read that file, check whether the backend is up and register
 * (or update) the "Fracta" server in Orbit's mcp-config.json — that is what
 * makes the tools show up for the agent.
 *
 * The same design as Nodara (./nodara.ts): the state combines both ends, and
 * a watcher on mcp.json keeps the credential up to date when the user generates a
 * new token or the backend comes up on another port.
 */

const HEALTH_TIMEOUT_MS = 2_500
const SETTINGS_WATCH_INTERVAL_MS = 10_000
/** The backend writes the URL when it starts; before that, the default port. */
const DEFAULT_MCP_URL = 'http://127.0.0.1:3000/mcp'

export const FRACTA_SERVER_NAME = 'Fracta'

/**
 * Fracta's data folder — the same convention as its backend
 * (backend/src/utils/appPaths.ts), which mirrors Electron's userData.
 * FRACTA_DATA_DIR, when absolute, counts there and here.
 */
function fractaDataDir(): string {
  const configured = process.env.FRACTA_DATA_DIR?.trim()
  if (configured && path.isAbsolute(configured)) return configured
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'fracta')
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'fracta')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'fracta')
}

const SETTINGS_PATH = path.join(fractaDataDir(), 'mcp.json')

interface FractaSettings {
  enabled?: boolean
  token?: string
  url?: string
}

async function readSettings(): Promise<FractaSettings | null> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(SETTINGS_PATH, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as FractaSettings
  } catch {
    return null
  }
}

function mcpUrlOf(settings: FractaSettings): string {
  return settings.url || DEFAULT_MCP_URL
}

type Probe = 'ok' | 'disabled' | 'unauthorized' | 'down'

/**
 * Checks whether the Fracta backend is up. There is no MCP of its own
 * /health, so an authenticated GET on /mcp without a session does the job: Fracta answers
 * 400 ("initialize first") when everything is fine, 401 for an invalid token and
 * 403 with the MCP server off — always in JSON-RPC.
 */
async function probe(settings: FractaSettings): Promise<Probe> {
  try {
    const response = await fetch(mcpUrlOf(settings), {
      headers: settings.token ? authHeader(settings.token) : {},
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    const body = (await response.json().catch(() => null)) as { jsonrpc?: string } | null
    if (body?.jsonrpc !== '2.0') return 'down'
    if (response.status === 403) return 'disabled'
    if (response.status === 401) return 'unauthorized'
    return 'ok'
  } catch {
    return 'down'
  }
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** Fracta's MCP entry, preserving the user's preferences when editing. */
function buildEntry(settings: FractaSettings, existing?: McpServerConfig): McpServerConfig {
  const headers = { ...(existing?.headers ?? {}) }
  delete headers.Authorization
  delete headers.authorization
  return {
    ...(existing ?? {}),
    name: FRACTA_SERVER_NAME,
    type: 'http',
    url: mcpUrlOf(settings),
    enabled: true,
    autoReconnect: existing?.autoReconnect ?? true,
    headers: { ...headers, ...(settings.token ? authHeader(settings.token) : {}) },
  }
}

function findEntry(servers: McpServerConfig[]): McpServerConfig | undefined {
  return servers.find((server) => server.name === FRACTA_SERVER_NAME)
}

/** Does the saved entry match what Fracta is publishing right now? */
function entryMatchesSettings(entry: McpServerConfig, settings: FractaSettings): boolean {
  if (entry.url !== mcpUrlOf(settings)) return false
  const current = entry.headers?.Authorization ?? entry.headers?.authorization
  return current === (settings.token ? `Bearer ${settings.token}` : undefined)
}

/** Translates the transport's raw error into a code the card can act on. */
function normalizeError(error?: string): string | undefined {
  if (!error) return undefined
  if (/turned off|\b403\b|forbidden/i.test(error)) return 'fracta-disabled'
  if (/unauthorized|invalid or missing mcp token|\b401\b/i.test(error)) return 'fracta-unauthorized'
  if (/ECONNREFUSED|fetch failed|timeout/i.test(error)) return 'fracta-unreachable'
  return error
}

/**
 * State of the integration: crosses mcp.json + Fracta backend's response with
 * what Orbit actually has registered and connected.
 */
export async function discoverFracta(): Promise<FractaStatus> {
  const settings = await readSettings()
  const config = await readMcpConfig()
  const entry = findEntry(config.servers)
  const runtime = listMcpStatus().find((s) => s.config.name === FRACTA_SERVER_NAME)

  const linked = !!entry
  const base = {
    linked,
    mcpUrl: settings ? mcpUrlOf(settings) : entry?.url,
    toolCount: runtime?.toolNames.length ?? 0,
    error: normalizeError(runtime?.error),
  }

  if (!settings) {
    // No mcp.json: Fracta never ran here, or it uses another data folder.
    // If Orbit has the entry and it is connected, the live connection counts.
    if (linked && runtime?.state === 'connected') return { ...base, state: 'connected', tokenStale: false }
    return { ...base, state: 'not-installed', tokenStale: false }
  }

  const health = await probe(settings)
  const tokenStale = linked && !!entry && !entryMatchesSettings(entry, settings)

  if (health === 'down') {
    return { ...base, state: settings.enabled === false ? 'disabled' : 'stopped', tokenStale }
  }
  // MCP server off in Fracta: reconnecting does not solve it, the user is the one who acts there.
  if (health === 'disabled') return { ...base, state: 'disabled', tokenStale }
  if (!linked) return { ...base, state: 'installed', tokenStale: false }
  if (runtime?.state === 'connected') return { ...base, state: 'connected', tokenStale }
  // An entry disabled in Orbit is not a failure: the Connect button reactivates it.
  return { ...base, state: entry?.enabled === false ? 'installed' : 'error', tokenStale }
}

/**
 * Registers (or repairs) Fracta's MCP server and connects. Returns the post-connection
 * state so the card reflects the real result, not the intention.
 */
export async function connectFracta(): Promise<FractaStatus> {
  const settings = await readSettings()
  if (!settings) return { ...(await discoverFracta()), error: 'fracta-not-found' }
  if (!settings.token) return { ...(await discoverFracta()), error: 'fracta-no-token' }
  const health = await probe(settings)
  if (health === 'down') return { ...(await discoverFracta()), error: 'fracta-not-running' }
  if (health === 'disabled') return { ...(await discoverFracta()), error: 'fracta-disabled' }
  if (health === 'unauthorized') return { ...(await discoverFracta()), error: 'fracta-unauthorized' }

  const config = await readMcpConfig()
  const existing = findEntry(config.servers)
  const entry = buildEntry(settings, existing)
  const index = config.servers.findIndex((server) => server.name === FRACTA_SERVER_NAME)
  if (index >= 0) config.servers[index] = entry
  else config.servers.push(entry)

  await saveMcpConfig(config)
  // saveMcpConfig only reconnects what changed; if the entry was identical and was
  // in error, it forces the new attempt here — the click has to count for something.
  const status = listMcpStatus().find((s) => s.config.name === FRACTA_SERVER_NAME)
  if (status && status.state !== 'connected') await reconnectMcp(FRACTA_SERVER_NAME)

  return discoverFracta()
}

/** Removes Fracta from the MCP servers (the app itself keeps running). */
export async function disconnectFracta(): Promise<FractaStatus> {
  const config = await readMcpConfig()
  const servers = config.servers.filter((server) => server.name !== FRACTA_SERVER_NAME)
  if (servers.length !== config.servers.length) await saveMcpConfig({ servers })
  return discoverFracta()
}

/**
 * Keeps the saved credential equal to the one in mcp.json. It only acts when the user has
 * already connected Fracta at some point — it never registers on its own.
 */
export async function syncFractaCredentials(): Promise<boolean> {
  const settings = await readSettings()
  if (!settings?.token) return false

  const config = await readMcpConfig()
  const existing = findEntry(config.servers)
  if (!existing || entryMatchesSettings(existing, settings)) return false

  const index = config.servers.findIndex((server) => server.name === FRACTA_SERVER_NAME)
  config.servers[index] = buildEntry(settings, existing)
  await saveMcpConfig(config)
  return true
}

let watching = false

/**
 * Watches Fracta's mcp.json: a token generated again in Settings →
 * Agents (MCP), or the backend coming up on another port, updates Orbit's entry
 * on its own. watchFile (stat polling) because Fracta rewrites the whole file
 * (temp + rename) and it may not even exist when Orbit starts.
 */
export function watchFractaSettings(): void {
  if (watching) return
  watching = true
  void syncFractaCredentials()
  watchFile(SETTINGS_PATH, { interval: SETTINGS_WATCH_INTERVAL_MS }, () => {
    void syncFractaCredentials()
  })
}

export function stopWatchingFractaSettings(): void {
  if (!watching) return
  unwatchFile(SETTINGS_PATH)
  watching = false
}
