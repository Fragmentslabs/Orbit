import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import type { ConnectionConfig } from '@orbit/companion-client'

const STORAGE_KEY = 'orbit_recent_connections'
const MAX_RECENT = 5

/**
 * Recent connection. Stores the PIN of the last successful connection so it can
 * reconnect with a single tap — the desktop PIN expires in 5 min, so if it
 * is out of date the connection simply fails with 'invalid_pin' and the
 * user falls back to the manual flow normally (same error handling as before).
 */
export interface RecentConnection {
  host: string
  port: number
  /** Desktop name (raw hostname), coming from auth:ok. NEVER the name of the
   *  phone: `ConnectionConfig.deviceName` is what THIS device sends for the
   *  desktop to display, and using it as a fallback made the recents list show
   *  the name of the phone itself instead of the PC. */
  deviceName?: string
  /** Last successful connection (epoch ms). */
  lastConnectedAt?: number
  /** PIN used in the last successful connection (expires in 5 min on the desktop). */
  pin?: string
  /** Persistent pairing token — reconnects without a PIN. */
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
      deviceName,
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
