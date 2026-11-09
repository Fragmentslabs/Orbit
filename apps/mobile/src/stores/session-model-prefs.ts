import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from './connection-store'
import { useSettingsStore } from './settings-store'

/**
 * Model selected PER CHAT (same pattern as the desktop: the model follows the
 * session, not the whole app). `overrides` holds the model chosen for each
 * session; a new chat uses the DRAFT key until the session is created (adopt). Without an
 * override, the last chat used applies and, at the end, the global default (which is the
 * model selected on the desktop, synchronized via HTTP). `recents` is global
 * (last 5 models really used in any chat) — mirror of the desktop.
 *
 * Synchronization with the desktop: the desktop is the source of truth for the overrides —
 * its renderer pushes the map to main (which passes it on to the companions via
 * WS 'session:model-change' and exposes it at GET /api/session-models). Mobile
 * applies the snapshot on hydration and on live events; choices made on
 * mobile are sent via WS 'models:select' (with sessionId) and the desktop
 * applies them in its store.
 */

const STORAGE_KEY = 'orbit_session_models'
const RECENTS_KEY = 'orbit_recent_models'
export const DRAFT_KEY = 'draft'
const MAX_RECENTS = 5

export interface SelectedModel {
  providerId: string
  modelId: string
}

export type SessionModelOverrides = Record<string, SelectedModel>

async function loadRecents(): Promise<SelectedModel[]> {
  try {
    const raw = await Storage.getItem(RECENTS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as SelectedModel[]
      if (Array.isArray(parsed)) return parsed.slice(0, MAX_RECENTS)
    }
  } catch {
    // corrupted recents — starts empty
  }
  return []
}

interface SessionModelPrefsState {
  overrides: SessionModelOverrides
  /** Last models used (global, most recent first, max. 5) */
  recents: SelectedModel[]
  hydrated: boolean
  /** Applies a snapshot coming from the desktop (HTTP or WS). In the connect snapshot
   *  (`authoritative`) the desktop wins for the chats that already exist — it is the source of
   *  truth of the per-chat choice; only the draft key (a different new chat in each
   *  device) stays local. Without it a chat whose model was changed on the desktop kept
   *  opening on the phone with the old model forever. */
  applySync: (remote: SessionModelOverrides, authoritative?: boolean) => void
  hydrate: () => Promise<void>
  /** Re-reads the desktop snapshot (API + live event 'session:model-change'). */
  fetchRemote: () => Promise<void>
  selectModel: (sessionId: string | null | undefined, providerId: string, modelId: string) => void
  /** Moves the override of the draft (new chat) to the session created on the 1st send */
  adopt: (sessionId: string, fallback?: SelectedModel) => void
  /** Records a model as "used" (enters the recents). Called only
   *  when the agent actually completed an answer — never on failure. */
  markUsed: (providerId?: string, modelId?: string) => void
  /** Removes a model from the recents ("x" button in the picker). */
  removeRecent: (providerId: string, modelId: string) => void
  clear: (sessionId: string) => void
}

export const useSessionModelPrefs = create<SessionModelPrefsState>((set, get) => ({
  overrides: {},
  recents: [],
  hydrated: false,

  applySync: (remote, authoritative) => {
    if (!remote || typeof remote !== 'object') return
    if (authoritative) {
      const next: SessionModelOverrides = {}
      for (const [key, value] of Object.entries(remote)) {
        if (key === DRAFT_KEY || !value || typeof value !== 'object') continue
        next[key] = { providerId: value.providerId, modelId: value.modelId }
      }
      const draft = get().overrides[DRAFT_KEY]
      if (draft) next[DRAFT_KEY] = draft
      if (JSON.stringify(next) === JSON.stringify(get().overrides)) return
      void Storage.setItem(STORAGE_KEY, JSON.stringify(next))
      set({ overrides: next })
      return
    }
    let changed = false
    const next = { ...get().overrides }
    for (const [key, value] of Object.entries(remote)) {
      if (next[key] === undefined && value && typeof value === 'object') {
        next[key] = { providerId: value.providerId, modelId: value.modelId }
        changed = true
      }
    }
    if (changed) {
      void Storage.setItem(STORAGE_KEY, JSON.stringify(next))
      set({ overrides: next })
    }
  },

  hydrate: async () => {
    // The read of the device is asynchronous: applying it over a choice made meanwhile
    // (the person picking a model right after opening the app) erased the choice.
    if (!get().hydrated) {
      try {
        const raw = await Storage.getItem(STORAGE_KEY)
        if (raw) set({ overrides: JSON.parse(raw) as SessionModelOverrides })
      } catch {
        // corrupted prefs — stays empty
      }
      set({ recents: await loadRecents() })
      set({ hydrated: true })
    }
    await get().fetchRemote()
  },

  /** Snapshot of the per-session overrides of the desktop (renderer → main → HTTP).
   *  Run on connect: the desktop is the source of truth for the chats that exist. */
  fetchRemote: async () => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    try {
      const res = await http.getSessionModels()
      if (res.ok && res.data) {
        const remote = (res.data as { overrides?: SessionModelOverrides }).overrides
        if (remote) get().applySync(remote, true)
      }
    } catch {
      // Offline — keeps the local cache
    }
  },

  selectModel: (sessionId, providerId, modelId) => {
    const selected: SelectedModel = { providerId, modelId }
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides, [key]: selected }
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })

    if (!sessionId) {
      // New chat: the chosen model also becomes the global default (same
      // behavior as the desktop) — the desktop is notified via HTTP.
      void useSettingsStore.getState().selectModel(providerId, modelId)
    } else {
      // Existing session: notifies the desktop to update the override in the
      // renderer (which passes it on to the other companions).
      const { wsClient } = useConnectionStore.getState()
      try {
        void wsClient.send({ type: 'models:select', providerId, modelId, sessionId } as any)
      } catch {
        // Offline: the explicit send of the model in every message keeps the
        // behavior even without the desktop knowing about the override.
      }
    }
  },

  adopt: (sessionId, fallback) => {
    const overrides = { ...get().overrides }
    let chosen: SelectedModel | undefined
    if (overrides[DRAFT_KEY] !== undefined) {
      chosen = overrides[DRAFT_KEY]
      overrides[sessionId] = chosen
      delete overrides[DRAFT_KEY]
    } else if (fallback) {
      // Without an explicit choice in the draft, it fixes the model actually used
      // (inherited from the last chat) so the session stays with it.
      chosen = fallback
      overrides[sessionId] = fallback
    } else {
      return
    }
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
    // The session was born on the desktop without any choice of its own, and the
    // desktop is the source of truth of the per-chat model — it has to know this one,
    // otherwise its next snapshot (authoritative on connect) erases it.
    if (chosen) {
      const { wsClient } = useConnectionStore.getState()
      void wsClient
        .send({ type: 'models:select', providerId: chosen.providerId, modelId: chosen.modelId, sessionId })
        .catch(() => {})
    }
  },

  markUsed: (providerId, modelId) => {
    if (!providerId || !modelId) return
    if (get().recents.some((r) => r.providerId === providerId && r.modelId === modelId)) return
    const recents = [{ providerId, modelId }, ...get().recents].slice(0, MAX_RECENTS)
    void Storage.setItem(RECENTS_KEY, JSON.stringify(recents))
    set({ recents })
  },

  removeRecent: (providerId, modelId) => {
    const recents = get().recents.filter((r) => !(r.providerId === providerId && r.modelId === modelId))
    void Storage.setItem(RECENTS_KEY, JSON.stringify(recents))
    set({ recents })
  },

  clear: (sessionId) => {
    const overrides = { ...get().overrides }
    delete overrides[sessionId]
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },
}))
