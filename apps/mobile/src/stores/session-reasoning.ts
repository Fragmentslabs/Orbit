import { create } from 'zustand'
import type { ModelReasoningPref } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from '~/stores/connection-store'
import { useReasoningPrefsStore } from '~/stores/reasoning-prefs'

/**
 * Thinking PER CHAT (same pattern as the model and the per-chat modes). `overrides`
 * holds the choice of each session; the new chat uses the DRAFT key until the session
 * is created (adopt) and, without an override, the PER-MODEL level that the desktop
 * keeps (reasoning-prefs) applies — the default of the Preferences.
 *
 * The desktop is the source of truth: it applies what the phone chooses (WS
 * 'session:prefs-select') and sends the whole map back through 'session:prefs-change'.
 */

const STORAGE_KEY = 'orbit_session_reasoning'
export const DRAFT_KEY = 'draft'

export type SessionReasoningMap = Record<string, ModelReasoningPref>

interface SessionReasoningState {
  overrides: SessionReasoningMap
  hydrated: boolean
  hydrate: () => Promise<void>
  /** Desktop snapshot (connect) or live event. On connect it only fills in
   *  what is missing (a choice made here wins); on a live event it replaces. */
  applySync: (remote: SessionReasoningMap, authoritative?: boolean) => void
  setPref: (sessionId: string | null | undefined, pref: ModelReasoningPref) => void
  adopt: (sessionId: string, fallback?: ModelReasoningPref) => void
  clear: (sessionId: string) => void
}

function normalizar(map: unknown): SessionReasoningMap {
  const out: SessionReasoningMap = {}
  if (!map || typeof map !== 'object') return out
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    const pref = value as Partial<ModelReasoningPref> | null
    if (!pref || typeof pref.enabled !== 'boolean') continue
    out[key] = {
      enabled: pref.enabled,
      ...(typeof pref.variantId === 'string' ? { variantId: pref.variantId } : {}),
    }
  }
  return out
}

export const useSessionReasoning = create<SessionReasoningState>((set, get) => ({
  overrides: {},
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await Storage.getItem(STORAGE_KEY)
      if (raw) set({ overrides: normalizar(JSON.parse(raw)) })
    } catch {
      // corrupted prefs — every chat follows the level of the model
    }
    set({ hydrated: true })
  },

  applySync: (remote, authoritative = false) => {
    const incoming = normalizar(remote)
    if (Object.keys(incoming).length === 0 && !authoritative) return

    let next: SessionReasoningMap
    if (authoritative) {
      // The desktop map replaces the local one — so a level that went back to
      // following the default there (key removed) also goes back here.
      next = { ...incoming }
      const draft = get().overrides[DRAFT_KEY]
      if (draft !== undefined) next[DRAFT_KEY] = draft
    } else {
      next = { ...get().overrides }
      let changed = false
      for (const [key, pref] of Object.entries(incoming)) {
        if (key === DRAFT_KEY || next[key] !== undefined) continue
        next[key] = pref
        changed = true
      }
      if (!changed) return
    }

    void Storage.setItem(STORAGE_KEY, JSON.stringify(next))
    set({ overrides: next, hydrated: true })
  },

  setPref: (sessionId, pref) => {
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides, [key]: pref }
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })

    // A new chat is per device: it does not travel. With a session, the desktop applies it in
    // its renderer (source of truth) and sends the snapshot back to everyone.
    if (!sessionId) return
    const { wsClient } = useConnectionStore.getState()
    try {
      void wsClient.send({ type: 'session:prefs-select', sessionId, reasoning: pref }).catch(() => {})
    } catch {
      // Offline: the send carries the thinking of the session in the turn itself.
    }
  },

  adopt: (sessionId, fallback) => {
    const overrides = { ...get().overrides }
    if (overrides[DRAFT_KEY] !== undefined) {
      overrides[sessionId] = overrides[DRAFT_KEY]
      delete overrides[DRAFT_KEY]
    } else if (fallback) {
      overrides[sessionId] = fallback
    } else {
      return
    }
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },

  clear: (sessionId) => {
    const overrides = { ...get().overrides }
    delete overrides[sessionId]
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },
}))

/** Effective level of the chat: session override > level of the model (desktop). */
export function sessionReasoningFor(
  sessionId: string | null | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): ModelReasoningPref | undefined {
  const override = useSessionReasoning.getState().overrides[sessionId ?? DRAFT_KEY]
  if (override) return override
  if (!providerId || !modelId) return undefined
  return useReasoningPrefsStore.getState().prefs[`${providerId}/${modelId}`]
}

export function useSessionReasoningPref(
  sessionId: string | null | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
) {
  const key = sessionId ?? DRAFT_KEY
  const override = useSessionReasoning((s) => s.overrides[key])
  const modelPref = useReasoningPrefsStore((s) =>
    providerId && modelId ? s.prefs[`${providerId}/${modelId}`] : undefined,
  )
  const setPref = useSessionReasoning((s) => s.setPref)
  const hydrate = useSessionReasoning((s) => s.hydrate)
  const hydrated = useSessionReasoning((s) => s.hydrated)

  const pref = override ?? modelPref

  return {
    enabled: pref?.enabled ?? false,
    variantId: pref?.variantId,
    /** true when this chat has already chosen (on or off) — the choice wins over the default */
    isExplicit: !!override,
    update: (next: ModelReasoningPref) => setPref(sessionId ?? null, next),
    hydrate,
    hydrated,
  }
}
