import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import type { ConnectionConfig } from '@orbit/companion-client'

const STORAGE_KEY = 'orbit_recent_connections'
const MAX_RECENT = 5

/**
 * Conexão recente. Guarda o PIN da última conexão bem-sucedida para permitir
 * reconectar com um toque — o PIN do desktop expira em 5 min, então se
 * estiver desatualizado a conexão simplesmente falha com 'invalid_pin' e o
 * usuário cai no fluxo manual normalmente (mesmo tratamento de erro já existente).
 */
export interface RecentConnection {
  host: string
  port: number
  /** Nome do desktop (hostname) descoberto na conexão. */
  deviceName?: string
  /** Última conexão bem-sucedida (epoch ms). */
  lastConnectedAt?: number
  /** PIN usado na última conexão bem-sucedida (expira em 5 min no desktop). */
  pin?: string
  /** Token persistente do pareamento — reconecta sem PIN. */
  token?: string
}

interface RecentConnectionsStore {
  recent: RecentConnection[]
  loadRecent: () => Promise<void>
  addRecent: (config: ConnectionConfig, deviceName?: string) => Promise<void>
  removeRecent: (host: string, port: number) => Promise<void>
  clearRecent: () => Promise<void>
}

export const useRecentConnectionsStore = create<RecentConnectionsStore>((set, get) => ({
  recent: [],

  loadRecent: async () => {
    try {
      const raw = await Storage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as RecentConnection[]
        set({ recent: parsed })
      }
    } catch { }
  },

  addRecent: async (config, deviceName) => {
    const filtered = get().recent.filter(
      (c) => c.host !== config.host || c.port !== config.port
    )
    const entry: RecentConnection = {
      host: config.host,
      port: config.port,
      deviceName: deviceName ?? config.deviceName,
      lastConnectedAt: Date.now(),
      pin: config.pin,
      token: config.token,
    }
    const next = [entry, ...filtered].slice(0, MAX_RECENT)
    set({ recent: next })
    await Storage.setItem(STORAGE_KEY, JSON.stringify(next))
  },

  removeRecent: async (host, port) => {
    const next = get().recent.filter((c) => c.host !== host || c.port !== port)
    set({ recent: next })
    await Storage.setItem(STORAGE_KEY, JSON.stringify(next))
  },

  clearRecent: async () => {
    set({ recent: [] })
    await Storage.removeItem(STORAGE_KEY)
  },
}))
