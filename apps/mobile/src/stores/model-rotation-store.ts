import i18n from '~/i18n'
import { create } from 'zustand'
import type { ModelRotation, RotationConfig } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from './connection-store'
import type { SelectedModel } from './session-model-prefs'

/**
 * Model rotation on the phone — mirror of the desktop store
 * (`apps/desktop/src/stores/model-rotation-store.ts`).
 *
 * Named model lists (1..4 slots) that the engine tries in sequence
 * when one fails at the start of the turn (rate limit, network, moderation). There is no
 * global toggle nor an "active" rotation: the rotation is created here and CHOSEN PER
 * CHAT in the model picker, as if it were a model. Choosing a model
 * clears the rotation of the chat (and vice versa).
 *
 * What runs the sequence is the desktop — the phone is a companion. The desktop
 * renderer is the source of truth (the state lives in its localStorage):
 *   - on connection the phone pulls the snapshot (`GET /api/rotations`);
 *   - changes on the desktop arrive through the WS 'rotation:change';
 *   - changes made here go through 'rotation:set' (CRUD, whole list) and
 *     'rotation:select' (choice per chat); the desktop persists and sends them back.
 *
 * The local cache exists only so the screen opens filled in offline; the desktop
 * snapshot replaces whatever is here, because that is where the list lives.
 */

const STORAGE_KEY = 'orbit_model_rotations'
export const ROTATION_DRAFT_KEY = 'draft'
export const MAX_ROTATION_SLOTS = 4

function newRotationId(): string {
  return `rot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function sanitize(config: unknown): RotationConfig {
  const parsed = config as Partial<RotationConfig> | null
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rotations)) {
    return { rotations: [], sessionOverrides: {} }
  }
  const rotations = parsed.rotations
    .filter((r): r is ModelRotation => !!r && typeof r.id === 'string')
    .map((r) => ({
      id: r.id,
      name: typeof r.name === 'string' ? r.name : '',
      models: Array.isArray(r.models) ? r.models.slice(0, MAX_ROTATION_SLOTS) : [],
    }))
  const ids = new Set(rotations.map((r) => r.id))
  const sessionOverrides: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed.sessionOverrides ?? {})) {
    if (typeof value === 'string' && ids.has(value)) sessionOverrides[key] = value
  }
  return { rotations, sessionOverrides }
}

interface ModelRotationState extends RotationConfig {
  hydrated: boolean
  hydrate: () => Promise<void>
  /** Snapshot coming from the desktop (HTTP on connect or WS 'rotation:change'). */
  applySync: (config: RotationConfig) => void
  create: (name: string) => ModelRotation
  rename: (id: string, name: string) => void
  updateModels: (id: string, models: SelectedModel[]) => void
  remove: (id: string) => void
  /** Pins the rotation in a chat (like choosing a model); null undoes it. */
  selectRotation: (sessionId: string | null | undefined, rotationId: string | null) => void
  /** Moves the choice of the draft (new chat) to the session created on the 1st send. */
  adoptRotation: (sessionId: string) => void
}

/** CRUD → desktop (source of truth), which persists and sends it back through the broadcast. */
function pushRotations(rotations: ModelRotation[]): void {
  const { wsClient } = useConnectionStore.getState()
  try {
    void wsClient.send({ type: 'rotation:set', rotations })
  } catch {
    // Offline: it stays in the local cache until the next connection, when the desktop
    // snapshot (which does not have the change) takes over again.
  }
}

export const useModelRotationStore = create<ModelRotationState>((set, get) => {
  const persist = (next: RotationConfig) => {
    void Storage.setItem(STORAGE_KEY, JSON.stringify(next))
    set(next)
  }

  return {
    rotations: [],
    sessionOverrides: {},
    hydrated: false,

    hydrate: async () => {
      try {
        const raw = await Storage.getItem(STORAGE_KEY)
        if (raw) set(sanitize(JSON.parse(raw)))
      } catch {
        // corrupted cache — stays empty
      }
      set({ hydrated: true })

      const { http } = useConnectionStore.getState()
      if (!http) return
      try {
        const res = await http.getRotations()
        if (res.ok && res.data?.config) get().applySync(res.data.config)
      } catch {
        // Offline — keeps the local cache
      }
    },

    applySync: (config) => {
      // The desktop sends the whole state; here it REPLACES the local one (unlike
      // the model overrides, where the local choice wins): the list of rotations
      // lives there, so diverging would mean showing a rotation that
      // no longer exists.
      persist(sanitize(config))
    },

    create: (name) => {
      const rotation: ModelRotation = { id: newRotationId(), name: name.trim() || i18n.t('rotation.newName'), models: [] }
      const rotations = [...get().rotations, rotation]
      persist({ rotations, sessionOverrides: get().sessionOverrides })
      pushRotations(rotations)
      return rotation
    },

    rename: (id, name) => {
      const rotations = get().rotations.map((r) =>
        r.id === id ? { ...r, name: name.trim() || r.name } : r,
      )
      persist({ rotations, sessionOverrides: get().sessionOverrides })
      pushRotations(rotations)
    },

    updateModels: (id, models) => {
      const rotations = get().rotations.map((r) =>
        r.id === id ? { ...r, models: models.slice(0, MAX_ROTATION_SLOTS) } : r,
      )
      persist({ rotations, sessionOverrides: get().sessionOverrides })
      pushRotations(rotations)
    },

    remove: (id) => {
      const rotations = get().rotations.filter((r) => r.id !== id)
      persist({
        rotations,
        // Chats that pointed to the removed rotation go back to the model
        sessionOverrides: Object.fromEntries(
          Object.entries(get().sessionOverrides).filter(([, v]) => v !== id),
        ),
      })
      pushRotations(rotations)
    },

    selectRotation: (sessionId, rotationId) => {
      const key = sessionId ?? ROTATION_DRAFT_KEY
      const next = { ...get().sessionOverrides }
      if (rotationId && get().rotations.some((r) => r.id === rotationId)) next[key] = rotationId
      else delete next[key]
      persist({ rotations: get().rotations, sessionOverrides: next })

      const { wsClient } = useConnectionStore.getState()
      try {
        void wsClient.send({
          type: 'rotation:select',
          rotationId: rotationId ?? null,
          sessionId: sessionId ?? null,
        })
      } catch {
        // Offline: with the desktop unaware of the choice, the turn runs on the model —
        // it is the engine there that resolves the sequence.
      }
    },

    adoptRotation: (sessionId) => {
      const overrides = { ...get().sessionOverrides }
      const draft = overrides[ROTATION_DRAFT_KEY]
      if (draft === undefined) return
      overrides[sessionId] = draft
      delete overrides[ROTATION_DRAFT_KEY]
      persist({ rotations: get().rotations, sessionOverrides: overrides })
      // The desktop does the same adopt in its store when the session is born over
      // there; here the session was born on the phone, so the choice is resent already
      // with the definitive id.
      const { wsClient } = useConnectionStore.getState()
      try {
        void wsClient.send({ type: 'rotation:select', rotationId: draft, sessionId })
      } catch {
        // Offline — the desktop reapplies it on the next send through the snapshot
      }
    },
  }
})

/** Rotation chosen for a chat (or null). Reactive hook for the picker. */
export function useSessionRotation(sessionId?: string | null): ModelRotation | null {
  const rotations = useModelRotationStore((s) => s.rotations)
  const overrides = useModelRotationStore((s) => s.sessionOverrides)
  const id = overrides[sessionId ?? ROTATION_DRAFT_KEY]
  return (id && rotations.find((r) => r.id === id)) || null
}
