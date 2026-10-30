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
  /** State of the WebSocket connection. */
  connection: ConnectionState
  /** Current configuration (host/port/pin). */
  config: ConnectionConfig | null
  /** Instance of the WebSocket client (singleton). */
  wsClient: CompanionWebSocket
  /** Instance of the HTTP client (singleton). */
  http: CompanionHttp | null
  /** Uptime of the desktop in seconds. */
  desktopUptime: number
  /** Number of active sessions on the desktop. */
  desktopActiveSessions: number

  /** Connects to the desktop with the given config. */
  connect: (config: ConnectionConfig) => void
  /** Disconnects and clears the state (explicit user action — forgets the saved config). */
  disconnect: () => void
  /** Closes the socket without forgetting the saved config (unmount/dev reload cleanup). */
  shutdown: () => void
  /** Updates the config (reconnects). */
  updateConfig: (config: ConnectionConfig) => void
  /** Saves the config in SecureStore for a future reconnection. */
  saveConfig: (config: ConnectionConfig) => Promise<void>
  /** true while loadConfig() is running. */
  loadingConfig: boolean
  /** Loads the config from SecureStore. Returns null when there is none. */
  loadConfig: () => Promise<ConnectionConfig | null>
  /** Clears the saved config. */
  clearSavedConfig: () => Promise<void>
  /** Registers a handler for a WS state change. */
  onConnectionChange: (handler: (state: ConnectionState) => void) => () => void
  /** Registers a handler for WS events. */
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

    // Creates/updates the HTTP client
    const http = new CompanionHttp(config)
    set({ http })

    // Connects the WS — the handshake + auth are handled internally
    wsClient.connect(config)

    // Saves the config for a future reconnection
    void get().saveConfig(config)

    // When the WS authenticates, it updates the token of the HTTP client and saves it
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
    // Only closes the socket — keeps the saved config for automatic reconnection.
    // Necessary because the cleanup of useEffect runs in dev (double-invoke /
    // fast refresh) and cannot erase the credentials.
    wsClient.disconnect()
    set({ connection: { status: 'disconnected' } })
  },

  updateConfig: (config) => {
    get().disconnect()
    get().connect(config)
  },

  onConnectionChange: (handler) => {
    let lastStatus = get().connection.status
    return wsClient.onStateChange((state) => {
      const statusChanged = state.status !== lastStatus
      lastStatus = state.status
      set({ connection: state })
      if (statusChanged) {
        handler(state)
      }
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

      // With a persistent token the PIN is dispensable (it expires in 5 min
      // anyway — it only served the first pairing).
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
