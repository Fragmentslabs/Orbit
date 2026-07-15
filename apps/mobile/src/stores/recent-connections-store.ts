import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import type { ConnectionConfig } from '@orbit/companion-client'

const STORAGE_KEY = 'orbit_recent_connections'
const MAX_RECENT = 5

/**
 * Conexão recente — sem PIN: o PIN do desktop expira em 5 minutos,
 * então guardamos apenas o endereço para pré-preencher o formulário.
 */
export interface RecentConnection {
  host: string
  port: number
  /** Nome do desktop (hostname) descoberto na conexão. */
  deviceName?: string
  /** Última conexão bem-sucedida (epoch ms). */
  lastConnectedAt?: number
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
        // Migração: entradas antigas podiam conter o PIN — descarta
        set({ recent: parsed.map(({ host, port, deviceName, lastConnectedAt }) => ({ host, port, deviceName, lastConnectedAt })) })
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
