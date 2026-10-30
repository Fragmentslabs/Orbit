/**
 * Orbit Desktop discovery on the network.
 *
 * Probes the public GET /api/ping endpoint (HTTP port 3848) on the candidates:
 *  - localhost / page hostname (web running on the same machine)
 *  - hosts of the recent connections
 *
 * The endpoint requires no auth and answers { app: 'orbit', name, wsPort }.
 */
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { useRecentConnectionsStore } from '~/stores/recent-connections-store'

const HTTP_PORT = 3848
const PROBE_TIMEOUT_MS = 2000

export interface DiscoveredDesktop {
  host: string
  /** WS port reported by the desktop (3847). */
  wsPort: number
  /** Hostname of the machine running Orbit Desktop. */
  name?: string
  /**
   * Current PIN — only filled in when the desktop is in "pairing
   * mode" (the "Connect App" modal open). It allows connecting with a
   * single tap; if absent, the UI falls back to the manual flow with a PIN.
   */
  pin?: string
}

async function probe(host: string): Promise<DiscoveredDesktop | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    const res = await fetch(`http://${host}:${HTTP_PORT}/api/ping`, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return null
    const data = (await res.json()) as { app?: string; name?: string; wsPort?: number; pin?: string }
    if (data.app !== 'orbit') return null
    return { host, wsPort: data.wsPort ?? 3847, name: data.name, pin: data.pin }
  } catch {
    return null
  }
}

export function useDesktopDiscovery() {
  const recent = useRecentConnectionsStore((s) => s.recent)
  const [status, setStatus] = useState<'checking' | 'found' | 'none'>('checking')
  const [found, setFound] = useState<DiscoveredDesktop | null>(null)

  useEffect(() => {
    let cancelled = false

    const candidates = new Set<string>()
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      candidates.add('localhost')
      const pageHost = window.location.hostname
      if (pageHost && pageHost !== 'localhost') candidates.add(pageHost)
    }
    for (const rc of recent) candidates.add(rc.host)

    // With no candidates the Promise.all([]) resolves immediately and falls back to 'none'.
    // setState only in the .then (asynchronous) to avoid a cascading render.
    void Promise.all([...candidates].map(probe)).then((results) => {
      if (cancelled) return
      const hit = results.find((r): r is DiscoveredDesktop => r !== null)
      setFound(hit ?? null)
      setStatus(hit ? 'found' : 'none')
    })

    return () => {
      cancelled = true
    }
  }, [recent])

  return { status, found }
}
