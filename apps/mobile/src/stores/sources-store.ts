import { create } from 'zustand'
import type { CompanionSourcesList } from '@orbit/shared'
import { useConnectionStore } from './connection-store'

/**
 * Sources of a conversation — read from the desktop (the source of truth, see
 * session-documents.ts) over HTTP. The desktop pushes WS `sources:changed` whenever the
 * set changes (from either side), and `refresh()` re-reads the open scope.
 */
interface SourcesState {
  /** Scope currently open on the screen (session id or 'draft'). */
  scope: string | null
  list: CompanionSourcesList | null
  loading: boolean
  error: string | null
  refresh: (scope?: string) => Promise<void>
}

export const useSourcesStore = create<SourcesState>((set, get) => ({
  scope: null,
  list: null,
  loading: false,
  error: null,

  refresh: async (scopeArg) => {
    const scope = scopeArg ?? get().scope
    if (!scope) return
    if (scope !== get().scope) set({ scope, list: null })
    const http = useConnectionStore.getState().http
    if (!http) return
    set({ loading: get().list === null })
    const res = await http.listSources(scope)
    // The screen may have moved to another scope while the request was in flight.
    if (get().scope !== scope) return
    if (res.ok && res.data) set({ list: res.data, error: null, loading: false })
    else set({ error: res.error ?? 'error', loading: false })
  },
}))
