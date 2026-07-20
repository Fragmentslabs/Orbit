import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import {
  CompanionWebSocket,
  CompanionHttp,
  type ConnectionConfig,
  type ConnectionState,
} from '@orbit/companion-client'

// ─── SecureStore Keys ───────────────────────────────────────────────────────

const STORAGE_KEY_HOST = 'orbit_conn_host'
const STORAGE_KEY_PORT = 'orbit_conn_port'
const STORAGE_KEY_PIN = 'orbit_conn_pin'
const STORAGE_KEY_TOKEN = 'orbit_conn_token'
const STORAGE_KEY_DEVICE = 'orbit_conn_device'

// ─── Store ──────────────────────────────────────────────────────────────────

interface ConnectionStore {
  /** Estado da conexão WebSocket. */
  connection: ConnectionState
  /** Configuração atual (host/port/pin). */
  config: ConnectionConfig | null
  /** Instância do cliente WebSocket (singleton). */
  wsClient: CompanionWebSocket
  /** Instância do cliente HTTP (singleton). */
  http: CompanionHttp | null
  /** Uptime do desktop em segundos. */
  desktopUptime: number
  /** Número de sessões ativas no desktop. */
  desktopActiveSessions: number

  /** Conecta ao desktop com a config fornecida. */
  connect: (config: ConnectionConfig) => void
  /** Desconecta e limpa estado (ação explícita do usuário — esquece a config salva). */
  disconnect: () => void
  /** Fecha o socket sem esquecer a config salva (cleanup de unmount/dev reload). */
  shutdown: () => void
  /** Atualiza config (reconecta). */
  updateConfig: (config: ConnectionConfig) => void
  /** Salva config no SecureStore para reconexão futura. */
  saveConfig: (config: ConnectionConfig) => Promise<void>
  /** true enquanto loadConfig() está rodando. */
  loadingConfig: boolean
  /** Carrega config do SecureStore. Retorna null se não houver. */
  loadConfig: () => Promise<ConnectionConfig | null>
  /** Limpa config salva. */
  clearSavedConfig: () => Promise<void>
  /** Registra handler para mudança de estado WS. */
  onConnectionChange: (handler: (state: ConnectionState) => void) => () => void
  /** Registra handler para eventos WS. */
  onEvent: (eventType: string, handler: (event: any) => void) => () => void
}

// ─── Singleton Instances ────────────────────────────────────────────────────

const wsClient = new CompanionWebSocket()

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  connection: { status: 'disconnected' },
  config: null,
  loadingConfig: true,
  wsClient,
  http: null,
  desktopUptime: 0,
  desktopActiveSessions: 0,

  connect: (config) => {
    set({ config, connection: { status: 'connecting' } })

    // Cria/ atualiza o HTTP client
    const http = new CompanionHttp(config)
    set({ http })

    // Conecta o WS — o handshake + auth são tratados internamente
    wsClient.connect(config)

    // Salva config para reconexão futura
    void get().saveConfig(config)

    // Quando o WS autenticar, atualiza o token do HTTP client e salva
    const unsub = wsClient.onStateChange((state) => {
      if (state.status === 'connected' && state.deviceToken) {
        http.setToken(state.deviceToken)
        unsub()
      }
    })
  },

  disconnect: () => {
    wsClient.disconnect()
    // Clear saved config so auto-reconnect doesn't kick in next time
    void get().clearSavedConfig()
    set({
      config: null,
      connection: { status: 'disconnected' },
      http: null,
      desktopUptime: 0,
      desktopActiveSessions: 0,
    })
  },

  shutdown: () => {
    // Apenas fecha o socket — mantém a config salva para reconexão automática.
    // Necessário porque o cleanup do useEffect roda em dev (double-invoke /
    // fast refresh) e não pode apagar as credenciais.
    wsClient.disconnect()
    set({ connection: { status: 'disconnected' } })
  },

  updateConfig: (config) => {
    get().disconnect()
    get().connect(config)
  },

  onConnectionChange: (handler) => {
    return wsClient.onStateChange((state) => {
      set({ connection: state })
      handler(state)
    })
  },

  onEvent: (eventType, handler) => {
    return wsClient.subscribe(eventType, handler)
  },

  // ─── Persistence ────────────────────────────────────────────────────────

  saveConfig: async (config) => {
    await Storage.setItem(STORAGE_KEY_HOST, config.host)
    await Storage.setItem(STORAGE_KEY_PORT, String(config.port))
    await Storage.setItem(STORAGE_KEY_PIN, config.pin)
    if (config.token) {
      await Storage.setItem(STORAGE_KEY_TOKEN, config.token)
    }
    if (config.deviceName) {
      await Storage.setItem(STORAGE_KEY_DEVICE, config.deviceName)
    }
  },

  loadConfig: async () => {
    set({ loadingConfig: true })
    try {
      const host = await Storage.getItem(STORAGE_KEY_HOST)
      const port = await Storage.getItem(STORAGE_KEY_PORT)
      const pin = await Storage.getItem(STORAGE_KEY_PIN)
      const token = await Storage.getItem(STORAGE_KEY_TOKEN)
      const deviceName = await Storage.getItem(STORAGE_KEY_DEVICE)

      // Com token persistente o PIN é dispensável (ele expira em 5 min de
      // qualquer forma — só serviu para o primeiro pareamento).
      if (!host || !port || (!pin && !token)) return null

      return {
        host,
        port: Number(port),
        pin: pin ?? '',
        token: token ?? undefined,
        deviceName: deviceName ?? undefined,
      }
    } finally {
      set({ loadingConfig: false })
    }
  },

  clearSavedConfig: async () => {
    await Storage.removeItem(STORAGE_KEY_HOST)
    await Storage.removeItem(STORAGE_KEY_PORT)
    await Storage.removeItem(STORAGE_KEY_PIN)
    await Storage.removeItem(STORAGE_KEY_TOKEN)
    await Storage.removeItem(STORAGE_KEY_DEVICE)
  },
}))
