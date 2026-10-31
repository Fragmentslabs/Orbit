import { useCallback } from "react"
import { create } from "zustand"

import type { SessionInfo } from "@shared/chat"
import type { ModelReasoningPref } from "@shared/companion"
import { useReasoningPrefsStore } from "@/src/stores/reasoning-prefs"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Thinking PER CHAT (toggle + variant), in the same design as the per-chat model:
 * `overrides` keeps each session's choice, the new chat uses the DRAFT key
 * until the first send (adopt) and, with no override, the level of the LAST CHAT USED
 * applies — the same rule the model already follows — falling back to the PER MODEL
 * level from the Preferences (reasoning-prefs), which remains the default.
 *
 * Before, the level was only per model: choosing "high" in one chat changed the thinking
 * of ALL the chats of that model. Now the switch in the chat's selector writes
 * here; the Preferences thinking (ModelThinkingMenu) remains the default
 * for when the chat has chosen nothing.
 */

const STORAGE_KEY = "orbit-session-reasoning"
const DRAFT_KEY = "draft"

type ReasoningMap = Record<string, ModelReasoningPref>

function load(): ReasoningMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") return {}
    const map: ReasoningMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue
      const pref = value as Partial<ModelReasoningPref>
      if (typeof pref.enabled !== "boolean") continue
      map[key] = {
        enabled: pref.enabled,
        ...(typeof pref.variantId === "string" ? { variantId: pref.variantId } : {}),
      }
    }
    return map
  } catch {
    // corrupted prefs → no override (every chat follows the model's level)
    return {}
  }
}

function persist(bySession: ReasoningMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bySession))
}

interface SessionReasoningState {
  overrides: ReasoningMap
  /** Choice made in the chat (or in the draft): applies only to it. */
  setPref: (sessionId: string | null | undefined, pref: ModelReasoningPref) => void
  /** Transfers the draft's choice to the newly created session; with no choice
   *  in the draft, pins the level actually used (the model's), so the chat that
   *  has already started does not change when the default changes. */
  adopt: (sessionId: string, fallback?: ModelReasoningPref) => void
  clear: (sessionId: string) => void
}

export const useSessionReasoning = create<SessionReasoningState>((set, get) => ({
  overrides: load(),

  setPref: (sessionId, pref) => {
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides, [key]: pref }
    persist(overrides)
    set({ overrides })
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
    persist(overrides)
    set({ overrides })
  },

  clear: (sessionId) => {
    const overrides = { ...get().overrides }
    delete overrides[sessionId]
    persist(overrides)
    set({ overrides })
  },
}))

/** Most recent session that is not archived and not a worker — the one whose
 *  thinking the next new chat follows (the same rule the per-chat model uses). */
function latestSession(sessions: SessionInfo[]): SessionInfo | undefined {
  return sessions.filter((s) => !s.archived && !s.parentId).sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

/** Effective level of a chat: session override > level of the last chat used (new chat) >
 *  model level (Preferences). */
export function sessionReasoningFor(
  sessionId: string | null | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): ModelReasoningPref | undefined {
  const { overrides } = useSessionReasoning.getState()
  const override = overrides[sessionId ?? DRAFT_KEY]
  if (override) return override
  if (!sessionId) {
    // A new chat with no choice of its own opens with the thinking of the last chat
    // used, instead of falling back to the model's default and changing level.
    const latest = latestSession(useSessionStore.getState().sessions)
    const inherited = latest ? overrides[latest.id] : undefined
    if (inherited) return inherited
  }
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
  // New chat: subscribed to the sessions so the selector already shows the level it
  // inherits from the last chat used, before the first send.
  const sessions = useSessionStore((s) => (sessionId ? undefined : s.sessions))
  const latest = !sessionId && sessions ? latestSession(sessions) : undefined
  const inherited = useSessionReasoning((s) => (latest ? s.overrides[latest.id] : undefined))
  const setPref = useSessionReasoning((s) => s.setPref)

  // The same reference on both sides avoids a needless re-render when only the other
  // store changed: the override, when it exists, is the only source.
  const pref = override ?? inherited ?? modelPref

  const update = useCallback(
    (next: ModelReasoningPref) => {
      setPref(sessionId ?? null, next)
    },
    [sessionId, setPref],
  )

  return { enabled: pref?.enabled ?? false, variantId: pref?.variantId, update }
}
