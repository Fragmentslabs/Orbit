import fsp from 'node:fs/promises'
import { watchFile, unwatchFile } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpServerConfig } from '@shared/mcp'
import type { FractaStatus } from '@shared/fracta'
import { listMcpStatus, readMcpConfig, reconnectMcp, saveMcpConfig } from './mcp'

/**
 * Integração oficial com o Fracta (bancos de dados via MCP).
 *
 * O Fracta guarda as configurações do seu servidor MCP em mcp.json, na pasta
 * de dados do app: se está ligado, o token de acesso e a URL em que o backend
 * está ouvindo. É o mesmo arquivo que a ponte STDIO do próprio Fracta lê.
 * Aqui a gente lê esse arquivo, confere se o backend está no ar e registra
 * (ou atualiza) o servidor "Fracta" no mcp-config.json do Orbit — é isso que
 * faz as tools aparecerem pro agente.
 *
 * Mesmo desenho do Nodara (./nodara.ts): o estado combina as duas pontas, e
 * um watcher no mcp.json mantém a credencial em dia quando o usuário gera um
 * token novo ou o backend sobe em outra porta.
 */

const HEALTH_TIMEOUT_MS = 2_500
const SETTINGS_WATCH_INTERVAL_MS = 10_000
/** O backend grava a URL ao subir; antes disso, a porta padrão. */
const DEFAULT_MCP_URL = 'http://127.0.0.1:3000/mcp'

export const FRACTA_SERVER_NAME = 'Fracta'

/**
 * Pasta de dados do Fracta — a mesma convenção do backend dele
 * (backend/src/utils/appPaths.ts), que espelha o userData do Electron.
 * FRACTA_DATA_DIR, quando absoluto, vale lá e cá.
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
 * Confere se o backend do Fracta está no ar. Não há /health próprio do MCP,
 * então um GET autenticado em /mcp sem sessão faz as vezes: o Fracta responde
 * 400 ("initialize first") quando tudo está certo, 401 para token inválido e
 * 403 com o servidor MCP desligado — sempre em JSON-RPC.
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

/** Entrada MCP do Fracta, preservando as preferências do usuário na edição. */
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

/** A entrada salva bate com o que o Fracta está publicando agora? */
function entryMatchesSettings(entry: McpServerConfig, settings: FractaSettings): boolean {
  if (entry.url !== mcpUrlOf(settings)) return false
  const current = entry.headers?.Authorization ?? entry.headers?.authorization
  return current === (settings.token ? `Bearer ${settings.token}` : undefined)
}

/** Traduz o erro cru do transporte num código acionável pelo card. */
function normalizeError(error?: string): string | undefined {
  if (!error) return undefined
  if (/turned off|\b403\b|forbidden/i.test(error)) return 'fracta-disabled'
  if (/unauthorized|invalid or missing mcp token|\b401\b/i.test(error)) return 'fracta-unauthorized'
  if (/ECONNREFUSED|fetch failed|timeout/i.test(error)) return 'fracta-unreachable'
  return error
}

/**
 * Estado da integração: cruza o mcp.json + resposta do backend do Fracta com
 * o que o Orbit realmente tem registrado e conectado.
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
    // Sem mcp.json: o Fracta nunca rodou aqui, ou usa outra pasta de dados.
    // Se o Orbit tem a entrada e ela está conectada, vale a conexão viva.
    if (linked && runtime?.state === 'connected') return { ...base, state: 'connected', tokenStale: false }
    return { ...base, state: 'not-installed', tokenStale: false }
  }

  const health = await probe(settings)
  const tokenStale = linked && !!entry && !entryMatchesSettings(entry, settings)

  if (health === 'down') {
    return { ...base, state: settings.enabled === false ? 'disabled' : 'stopped', tokenStale }
  }
  // Servidor MCP desligado no Fracta: reconectar não resolve, quem age é o usuário lá dentro.
  if (health === 'disabled') return { ...base, state: 'disabled', tokenStale }
  if (!linked) return { ...base, state: 'installed', tokenStale: false }
  if (runtime?.state === 'connected') return { ...base, state: 'connected', tokenStale }
  // Entrada desabilitada no Orbit não é falha: o botão Conectar reativa.
  return { ...base, state: entry?.enabled === false ? 'installed' : 'error', tokenStale }
}

/**
 * Registra (ou repara) o servidor MCP do Fracta e conecta. Retorna o estado
 * pós-conexão para o card refletir o resultado real, não a intenção.
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
  // saveMcpConfig só reconecta o que mudou; se a entrada era idêntica e estava
  // em erro, força a nova tentativa aqui — o clique tem que valer alguma coisa.
  const status = listMcpStatus().find((s) => s.config.name === FRACTA_SERVER_NAME)
  if (status && status.state !== 'connected') await reconnectMcp(FRACTA_SERVER_NAME)

  return discoverFracta()
}

/** Remove o Fracta dos servidores MCP (o app em si continua rodando). */
export async function disconnectFracta(): Promise<FractaStatus> {
  const config = await readMcpConfig()
  const servers = config.servers.filter((server) => server.name !== FRACTA_SERVER_NAME)
  if (servers.length !== config.servers.length) await saveMcpConfig({ servers })
  return discoverFracta()
}

/**
 * Mantém a credencial salva igual à do mcp.json. Só age quando o usuário já
 * conectou o Fracta alguma vez — nunca registra sozinho.
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
 * Observa o mcp.json do Fracta: um token gerado de novo em Configurações →
 * Agentes (MCP), ou o backend subindo em outra porta, atualiza a entrada do
 * Orbit sozinha. watchFile (stat polling) porque o Fracta reescreve o arquivo
 * inteiro (temp + rename) e ele pode nem existir quando o Orbit sobe.
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
