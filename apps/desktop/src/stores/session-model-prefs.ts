import { create } from "zustand"

import type { SessionInfo } from "@shared/chat"
import type { SelectedModel } from "@/src/stores/provider-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionStore } from "@/src/stores/session-store"
import { sessionModelsApi } from "@/src/lib/ipc"
import { useModelRotationStore } from "@/src/stores/model-rotation-store"

/**
 * Model selected PER CHAT (opencode's default: the model follows the session,
 * not the whole app). `overrides` keeps the model chosen for each session;
 * new chats use the DRAFT key until the first send (adopt), when the
 * override becomes the session's. With no override, the provider's global default applies.
 * `recents` is global (the last 5 models chosen in any chat).
 */

const STORAGE_KEY = "orbit-session-models"
const RECENTS_KEY = "orbit-recent-models"
const DRAFT_KEY = "draft"
const MAX_RECENTS = 5

function loadRecord(): Record<string, SelectedModel> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as Record<string, SelectedModel>
  } catch {
    // corrupted prefs — starts over without overrides
  }
  return {}
}

function persistRecord(overrides: Record<string, SelectedModel>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

function loadRecents(): SelectedModel[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as SelectedModel[]
      if (Array.isArray(parsed)) return parsed.slice(0, MAX_RECENTS)
    }
  } catch {
    // corrupted recents — starts over empty
  }
  return []
}

function persistRecents(recents: SelectedModel[]) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(recents))
}

interface SessionModelPrefsState {
  overrides: Record<string, SelectedModel>
  /** Last models used (global, most recent first, max. 5) */
  recents: SelectedModel[]
  selectModel: (sessionId: string | null | undefined, providerId: string, modelId: string) => void
  /** Moves the draft's override (new chat) to the session created on the 1st send */
  adopt: (sessionId: string, fallback?: SelectedModel) => void
  /** Records a model as "used" (it goes into recents). Called only
   *  when the agent actually finished an answer — never on failure. */
  markUsed: (providerId?: string, modelId?: string) => void
  /** Removes a model from recents (the "x" button in the selector). */
  removeRecent: (providerId: string, modelId: string) => void
  clear: (sessionId: string) => void
  /** Swaps, in overrides and recents, the models `next` maps to another
   *  (rename in the catalog — see model-migration-sync). */
  remap: (next: (model: SelectedModel) => SelectedModel | undefined) => void
}

export const useSessionModelPrefs = create<SessionModelPrefsState>((set, get) => ({
  overrides: loadRecord(),
  recents: loadRecents(),

selectModel: (sessionId, providerId, modelId) => {
    const selected: SelectedModel = { providerId, modelId }
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides, [key]: selected }
    persistRecord(overrides)

    // NOTE: choosing does not touch `recents` — a model only goes into recents
    // when it is really used (markUsed, at the end of an agent answer).
    set({ overrides })

    // Pushes the map to main (HTTP cache + relay to the companions)
    sessionModelsApi.sync(overrides)

    // New chat (draft): the chosen model also becomes the global default,
    // so the next new chat already opens in it.
    if (!sessionId) useProviderStore.getState().selectModel(providerId, modelId)
  },

  adopt: (sessionId, fallback) => {
    const overrides = { ...get().overrides }
    if (overrides[DRAFT_KEY] !== undefined) {
      overrides[sessionId] = overrides[DRAFT_KEY]
      delete overrides[DRAFT_KEY]
    } else if (fallback) {
      // With no explicit choice in the draft, pins the model actually used
      // (inherited from the last chat) so the session continues in it.
      overrides[sessionId] = fallback
    } else {
      return
    }
    persistRecord(overrides)
    set({ overrides })
    sessionModelsApi.sync(overrides)
  },

  markUsed: (providerId, modelId) => {
    if (!providerId || !modelId) return
    if (get().recents.some((r) => r.providerId === providerId && r.modelId === modelId)) return
    const recents = [{ providerId, modelId }, ...get().recents].slice(0, MAX_RECENTS)
    persistRecents(recents)
    set({ recents })
  },

  removeRecent: (providerId, modelId) => {
    const recents = get().recents.filter((r) => !(r.providerId === providerId && r.modelId === modelId))
    persistRecents(recents)
    set({ recents })
  },

  clear: (sessionId) => {
    const overrides = { ...get().overrides }
    delete overrides[sessionId]
    persistRecord(overrides)
    set({ overrides })
    sessionModelsApi.sync(overrides)
  },

  remap: (next) => {
    let changed = false
    const overrides: Record<string, SelectedModel> = {}
    for (const [key, model] of Object.entries(get().overrides)) {
      const renamed = next(model)
      if (renamed) changed = true
      overrides[key] = renamed ?? model
    }
    const recents = get().recents.map((model) => {
      const renamed = next(model)
      if (renamed) changed = true
      return renamed ?? model
    })
    if (!changed) return
    persistRecord(overrides)
    persistRecents(recents)
    set({ overrides, recents })
    sessionModelsApi.sync(overrides)
  },
}))

// Sync with companions (mobile): pushes the initial state to main
// (after a renderer reload the main cache has to be repopulated) and applies
// selections made by the companions via WS 'models:select' / HTTP PUT selected.
if (typeof window !== "undefined" && window.ipcRenderer) {
  sessionModelsApi.sync(loadRecord())
  sessionModelsApi.onSelect(({ providerId, modelId, sessionId }) => {
    if (providerId && modelId) {
      // Choosing a model undoes the chat's rotation — the same pair as the
      // desktop selector (model-picker.tsx). Without this the rotation would keep winning,
      // Vision mode: the configured model has to exist, be connected and have
      useModelRotationStore.getState().selectRotation(sessionId ?? null, null)
      useSessionModelPrefs.getState().selectModel(sessionId ?? null, providerId, modelId)
    }
  })
}

/** Most recent session that is not archived and not a worker — its model is the default
 *  for the next new chat. */
function latestSession(sessions: SessionInfo[]): SessionInfo | undefined {
  return sessions.filter((s) => !s.archived && !s.parentId).sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

/** Override inherited from the PARENT: a subchat has no choice of its own until someone
 *  changes the model in it. Without this it fell into the provider's GLOBAL default, which
 *  may be another model (a subchat opened from a chat in DeepSeek
 *  was born in Claude). It climbs the chain up to the first ancestor with an override. */
function inheritedOverride(
  sessionId: string,
  overrides: Record<string, SelectedModel>,
  sessions: SessionInfo[],
): SelectedModel | undefined {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const seen = new Set<string>()
  let parentId = byId.get(sessionId)?.parentId
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const override = overrides[parentId]
    if (override) return override
    parentId = byId.get(parentId)?.parentId
  }
  return undefined
}

/** Effective model of the session: per-chat override > override inherited from the parent
 *  (subchats) > provider's global default. A new chat (draft) with no explicit
 *  choice inherits the model of the last chat used (override of the most recent
 *  session) before falling back to the global default. */
export function sessionModelFor(sessionId?: string | null): SelectedModel | null {
  const prefs = useSessionModelPrefs.getState()
  const override = prefs.overrides[sessionId ?? DRAFT_KEY]
  if (override) return override
  if (sessionId) {
    return (
      inheritedOverride(sessionId, prefs.overrides, useSessionStore.getState().sessions) ??
      useProviderStore.getState().selectedModel
    )
  }
  const latest = latestSession(useSessionStore.getState().sessions)
  const latestOverride = latest ? prefs.overrides[latest.id] : undefined
  if (latestOverride) return latestOverride
  return useProviderStore.getState().selectedModel
}

/** Reactive hook for the session's effective model (reacts to the override, to the default and to the
 *  most recent session — so the new chat follows the last model used). */
export function useSessionModel(sessionId?: string | null): SelectedModel | null {
  const overrides = useSessionModelPrefs((s) => s.overrides)
  const globalModel = useProviderStore((s) => s.selectedModel)
  const sessions = useSessionStore((s) => s.sessions)
  const override = sessionId ? overrides[sessionId] : overrides[DRAFT_KEY]
  if (override) return override
  if (sessionId) return inheritedOverride(sessionId, overrides, sessions) ?? globalModel
  const latest = latestSession(sessions)
  return (latest && overrides[latest.id]) ?? globalModel
}
