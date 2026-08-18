import fsp from 'node:fs/promises'
import { watchFile, unwatchFile } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpServerConfig } from '@shared/mcp'
import type { NodaraStatus } from '@shared/nodara'
import { listMcpStatus, readMcpConfig, reconnectMcp, saveMcpConfig } from './mcp'

/**
 * Integração oficial com o Nodara (controle de dispositivos Android via MCP).
 *
 * O Nodara publica um "bridge file" em ~/.nodara/mcp.json com a URL do seu
 * servidor MCP local e o token de acesso. Aqui a gente lê esse arquivo,
 * confere se o app está no ar (/health) e registra/atualiza o servidor
 * "Nodara" no mcp-config.json do Orbit — é isso que faz as tools aparecerem
 * pro agente.
 *
 * Dois pontos que a primeira versão errava e agora são tratados:
 *  - O estado exibido vinha só do /health do Nodara. O app podia estar rodando
 *    (= "conectado") sem nenhuma entrada MCP no Orbit, então o agente não
 *    tinha tool nenhuma. Agora o estado combina as duas pontas.
 *  - O token do Nodara pode ser regenerado (e a porta, trocada). A entrada
 *    salva no Orbit ficava com o token velho e todo request voltava 401. Um
 *    watcher no bridge file mantém a credencial em dia.
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

/** Confere se o servidor local do Nodara está no ar (o /health é público). */
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
  // O Nodara aceita Bearer, X-Nodara-Token ou ?token=. Header é preferível:
  // mantém o token fora da URL exibida no card e na lista de servidores MCP.
  return { Authorization: `Bearer ${token}` }
}

/** Entrada MCP do Nodara, preservando as preferências do usuário na edição. */
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

/** A entrada salva bate com o que o Nodara está publicando agora? */
function entryMatchesBridge(entry: McpServerConfig, bridge: NodaraBridge): boolean {
  if (entry.url !== bridge.mcpUrl) return false
  const current = entry.headers?.Authorization ?? entry.headers?.authorization
  return current === (bridge.token ? `Bearer ${bridge.token}` : undefined)
}

/**
 * Traduz o erro cru do transporte num código acionável. Um 401 do Nodara
 * chega como "Streamable HTTP error: Error POSTing to endpoint: {"error":
 * "Unauthorized"}" — inútil pra quem só quer saber que precisa reconectar.
 */
function normalizeError(error?: string): string | undefined {
  if (!error) return undefined
  if (/unauthorized|\b401\b|forbidden|\b403\b/i.test(error)) return 'nodara-unauthorized'
  if (/ECONNREFUSED|fetch failed|timeout/i.test(error)) return 'nodara-unreachable'
  return error
}

/**
 * Estado da integração: cruza o bridge file + /health do Nodara com o que o
 * Orbit realmente tem registrado e conectado.
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
    // Sem bridge file: ou o Nodara nunca rodou, ou foi desinstalado. Se o
    // Orbit tem a entrada e ela está conectada, o que vale é a conexão viva.
    if (linked && runtime?.state === 'connected') return { ...base, state: 'connected', tokenStale: false }
    return { ...base, state: 'not-installed', tokenStale: false }
  }

  const running = !!bridge.mcpUrl && (await probeHealth(bridge.mcpUrl))
  const tokenStale = linked && !!entry && !entryMatchesBridge(entry, bridge)

  if (!running) {
    // "disabled" é a ponte desligada nas configurações do Nodara: reconectar
    // não resolve, quem tem que agir é o usuário lá dentro.
    return { ...base, state: bridge.enabled === false ? 'disabled' : 'stopped', tokenStale }
  }
  if (!linked) return { ...base, state: 'installed', tokenStale: false }
  if (runtime?.state === 'connected') return { ...base, state: 'connected', tokenStale }
  // Entrada desabilitada no Orbit não é falha: o botão Conectar reativa.
  return { ...base, state: entry?.enabled === false ? 'installed' : 'error', tokenStale }
}

/**
 * Registra (ou repara) o servidor MCP do Nodara e conecta. Retorna o estado
 * pós-conexão para o card refletir o resultado real, não a intenção.
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
  // saveMcpConfig só reconecta o que mudou; se a entrada era idêntica e estava
  // em erro, força a nova tentativa aqui — o clique tem que valer alguma coisa.
  const status = listMcpStatus().find((s) => s.config.name === NODARA_SERVER_NAME)
  if (status && status.state !== 'connected') await reconnectMcp(NODARA_SERVER_NAME)

  return discoverNodara()
}

/** Remove o Nodara dos servidores MCP (o app em si continua rodando). */
export async function disconnectNodara(): Promise<NodaraStatus> {
  const config = await readMcpConfig()
  const servers = config.servers.filter((server) => server.name !== NODARA_SERVER_NAME)
  if (servers.length !== config.servers.length) await saveMcpConfig({ servers })
  return discoverNodara()
}

/**
 * Mantém a credencial salva igual à do bridge file. Só age quando o usuário
 * já conectou o Nodara alguma vez — nunca registra sozinho.
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
 * Observa ~/.nodara/mcp.json: quando o Nodara reinicia com outra porta ou o
 * token é regenerado, a entrada do Orbit se atualiza sozinha em vez de ficar
 * batendo 401. watchFile (stat polling) porque o arquivo é reescrito inteiro
 * pelo Nodara e pode nem existir ainda quando o Orbit sobe.
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
