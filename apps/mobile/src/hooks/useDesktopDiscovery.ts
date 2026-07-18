/**
 * Descoberta de Orbit Desktop na rede.
 *
 * Sonda o endpoint público GET /api/ping (porta HTTP 3848) nos candidatos:
 *  - localhost / hostname da página (web rodando na mesma máquina)
 *  - hosts das conexões recentes
 *
 * O endpoint não exige auth e responde { app: 'orbit', name, wsPort }.
 */
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { useRecentConnectionsStore } from '~/stores/recent-connections-store'

const HTTP_PORT = 3848
const PROBE_TIMEOUT_MS = 2000

export interface DiscoveredDesktop {
  host: string
  /** Porta WS informada pelo desktop (3847). */
  wsPort: number
  /** Hostname da máquina rodando o Orbit Desktop. */
  name?: string
  /**
   * PIN atual — só vem preenchido se o desktop estiver em "modo de
   * pareamento" (modal "Conectar App" aberto). Permite conectar com um
   * toque; se ausente, a UI cai de volta para o fluxo manual com PIN.
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

    // Sem candidatos o Promise.all([]) resolve imediatamente e cai em 'none'.
    // setState apenas no .then (assíncrono) para não causar cascading render.
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
