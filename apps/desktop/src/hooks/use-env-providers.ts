import { useEffect } from "react"
import { create } from "zustand"
import type { Catalog } from "@shared/chat"
import type { ProvidersSnapshotResponse } from "@shared/companion"
import { peersApi } from "@/src/lib/ipc"
import { usePeersStore } from "@/src/stores/peers-store"
import { useProviderStore, type SelectedModel } from "@/src/stores/provider-store"

/**
 * The models of the machine on screen. This computer's are the provider store's; another
 * desktop's are read once from that machine (what it has connected, its custom providers
 * and its default model) — a routine or a pipeline created there must name a model that
 * exists THERE, not the ones this machine happens to have.
 */

interface RemoteProvidersState {
  byPeer: Record<string, ProvidersSnapshotResponse | undefined>
  loading: Record<string, boolean>
  load: (peerId: string, force?: boolean) => Promise<void>
}

const useRemoteProviders = create<RemoteProvidersState>((set, get) => ({
  byPeer: {},
  loading: {},
  load: async (peerId, force = false) => {
    if (get().loading[peerId] || (!force && get().byPeer[peerId])) return
    set((s) => ({ loading: { ...s.loading, [peerId]: true } }))
    try {
      const snapshot = await peersApi.request<ProvidersSnapshotResponse>(peerId, { type: "providers:snapshot" })
      set((s) => ({ byPeer: { ...s.byPeer, [peerId]: snapshot } }))
    } catch {
      /* offline or view-only: the picker stays empty until the next attempt */
    } finally {
      set((s) => ({ loading: { ...s.loading, [peerId]: false } }))
    }
  },
}))

const NO_PROVIDERS: string[] = []
const NO_CATALOG: Catalog = {}

export interface EnvProviders {
  catalog: Catalog
  connectedProviders: string[]
  /** The default model of that machine (another desktop only; this one uses its own store). */
  defaultModel: SelectedModel | null
  remote: boolean
  loading: boolean
}

export function useEnvProviders(): EnvProviders {
  const env = usePeersStore((s) => s.env)
  const catalog = useProviderStore((s) => s.catalog)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)
  const selectedModel = useProviderStore((s) => s.selectedModel)
  const loadingLocal = useProviderStore((s) => s.loading)
  const remote = env !== "local"
  const snapshot = useRemoteProviders((s) => (remote ? s.byPeer[env] : undefined))
  const loadingRemote = useRemoteProviders((s) => (remote ? !!s.loading[env] : false))
  const load = useRemoteProviders((s) => s.load)

  useEffect(() => {
    if (remote) void load(env)
  }, [remote, env, load])

  if (!remote) return { catalog, connectedProviders, defaultModel: selectedModel, remote: false, loading: loadingLocal }
  return {
    catalog: (snapshot?.catalog as Catalog | undefined) ?? NO_CATALOG,
    connectedProviders: snapshot?.connectedProviders ?? NO_PROVIDERS,
    defaultModel: snapshot?.selectedModel ?? null,
    remote: true,
    loading: loadingRemote && !snapshot,
  }
}
