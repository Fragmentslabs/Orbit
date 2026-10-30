import i18n from "@/src/i18n"
import { create } from "zustand"

import type { ModelRotation, RotationConfig } from "@shared/chat"
import type { SelectedModel } from "@/src/stores/provider-store"
import { rotationApi } from "@/src/lib/ipc"

/**
 * Model rotation — named lists of models (1..4 slots) for the engine
 * to try in sequence when one fails at the start of the turn (rate-limit, network,
 * moderation). There is no global toggle nor an "active" rotation: the rotation is only
 * created/managed here and CHOSEN PER CHAT in the model selector, as if
 * it were a model (`sessionOverrides` = session → rotation; "draft" = new
 * chat before the first send). Choosing a model in the selector clears the
 * chat's rotation (and vice-versa).
 *
 * The state lives in localStorage (same pattern as session-model-prefs) and is
 * pushed to main through `rotation:sync` — it is main that resolves the
 * turn's sequence at call time (electron/lib/model-rotation.ts).
 */

const STORAGE_KEY = "orbit-model-rotations"
export const ROTATION_DRAFT_KEY = "draft"
export const MAX_ROTATION_SLOTS = 4

function newRotationId(): string {
  return `rot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function loadState(): RotationConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as RotationConfig
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.rotations)) {
        // Shape v1 had enabled/activeId — ignored. The per-chat choice is
        // read from whatever is already saved (or empty).
        const overrides: Record<string, string> = {}
        if (parsed.sessionOverrides && typeof parsed.sessionOverrides === "object") {
          for (const [key, value] of Object.entries(parsed.sessionOverrides)) {
            if (typeof value === "string") overrides[key] = value
          }
        }
        return {
          rotations: parsed.rotations.filter((r) => r && typeof r.id === "string"),
          sessionOverrides: overrides,
        }
      }
    }
  } catch {
    // corrupted state — starts over without rotations
  }
  return { rotations: [], sessionOverrides: {} }
}

interface ModelRotationState extends RotationConfig {
  create: (name: string) => ModelRotation
  rename: (id: string, name: string) => void
  updateModels: (id: string, models: SelectedModel[]) => void
  remove: (id: string) => void
  /** Pins the rotation in a chat (like choosing a model); rotationId null undoes it. */
  selectRotation: (sessionId: string | null | undefined, rotationId: string | null) => void
  /** Moves the draft's choice (new chat) to the session created on the 1st send. */
  adoptRotation: (sessionId: string) => void
  /** Replaces the whole list — used by the CRUD coming from a companion
   *  (`rotation:set`), which sends the complete state instead of a verb per
   *  operation. Per-chat choices pointing to rotations that vanished are
   *  discarded, as in `remove`. */
  replaceAll: (rotations: ModelRotation[]) => void
}

/** Syncs the whole state with main (the engine's cache). */
function sync(rotation: RotationConfig) {
  rotationApi.sync(rotation)
}

export const useModelRotationStore = create<ModelRotationState>((set, get) => {
  const persist = (next: RotationConfig) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    sync(next)
    set(next)
  }

  return {
    ...loadState(),

    create: (name) => {
      const rotation: ModelRotation = { id: newRotationId(), name: name.trim() || i18n.t("rotation.newName"), models: [] }
      const { rotations, sessionOverrides } = get()
      persist({ rotations: [...rotations, rotation], sessionOverrides })
      return rotation
    },

    rename: (id, name) => {
      const { rotations, sessionOverrides } = get()
      persist({
        rotations: rotations.map((r) => (r.id === id ? { ...r, name: name.trim() || r.name } : r)),
        sessionOverrides,
      })
    },

    updateModels: (id, models) => {
      const { rotations, sessionOverrides } = get()
      persist({
        rotations: rotations.map((r) => (r.id === id ? { ...r, models: models.slice(0, MAX_ROTATION_SLOTS) } : r)),
        sessionOverrides,
      })
    },

    remove: (id) => {
      const { rotations, sessionOverrides } = get()
      persist({
        rotations: rotations.filter((r) => r.id !== id),
        // Sessions that pointed to the removed rotation go back to the default
        sessionOverrides: Object.fromEntries(Object.entries(sessionOverrides).filter(([, v]) => v !== id)),
      })
    },

    selectRotation: (sessionId, rotationId) => {
      const key = sessionId ?? ROTATION_DRAFT_KEY
      const { rotations, sessionOverrides } = get()
      const next = { ...sessionOverrides }
      if (rotationId && rotations.some((r) => r.id === rotationId)) next[key] = rotationId
      else delete next[key]
      persist({ rotations, sessionOverrides: next })
    },

    replaceAll: (rotations) => {
      const valid = rotations
        .filter((r) => r && typeof r.id === "string")
        .map((r) => ({ ...r, models: (r.models ?? []).slice(0, MAX_ROTATION_SLOTS) }))
      const ids = new Set(valid.map((r) => r.id))
      const { sessionOverrides } = get()
      persist({
        rotations: valid,
        sessionOverrides: Object.fromEntries(
          Object.entries(sessionOverrides).filter(([, v]) => ids.has(v)),
        ),
      })
    },

    adoptRotation: (sessionId) => {
      const { rotations, sessionOverrides } = get()
      if (sessionOverrides[ROTATION_DRAFT_KEY] === undefined) return
      const next = { ...sessionOverrides }
      next[sessionId] = next[ROTATION_DRAFT_KEY]
      delete next[ROTATION_DRAFT_KEY]
      persist({ rotations, sessionOverrides: next })
    },
  }
})

// Repopulates the main cache after a renderer reload (same mechanics as
// sessionModelsApi in session-model-prefs) and applies what was done on the
// companions: the renderer is the source of truth (the state lives in
// its localStorage), so the phone's choice/CRUD is persisted here and
// goes back to everyone through `rotation:sync` → broadcast.
if (typeof window !== "undefined" && window.ipcRenderer) {
  rotationApi.sync(loadState())

  rotationApi.onSelect(({ rotationId, sessionId }) => {
    useModelRotationStore.getState().selectRotation(sessionId ?? null, rotationId ?? null)
  })

  rotationApi.onSet(({ rotations }) => {
    if (!Array.isArray(rotations)) return
    useModelRotationStore.getState().replaceAll(rotations)
  })
}