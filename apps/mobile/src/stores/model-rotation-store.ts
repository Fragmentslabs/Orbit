import { create } from 'zustand'
import type { ModelRotation, RotationConfig } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from './connection-store'
import type { SelectedModel } from './session-model-prefs'

/**
 * Rotação de modelos no celular — espelho do store do desktop
 * (`apps/desktop/src/stores/model-rotation-store.ts`).
 *
 * Listas nomeadas de modelos (1..4 slots) que o engine tenta em sequência
 * quando um falha no início do turno (rate-limit, rede, moderação). Não há
 * toggle global nem rotação "ativa": a rotação é criada aqui e ESCOLHIDA POR
 * CHAT no seletor de modelo, como se fosse um modelo. Escolher um modelo
 * limpa a rotação do chat (e vice-versa).
 *
 * Quem roda a sequência é o desktop — o celular é companion. O renderer do
 * desktop é a fonte da verdade (o estado vive no localStorage dele):
 *   - na conexão o celular puxa o snapshot (`GET /api/rotations`);
 *   - mudanças no desktop chegam pelo WS 'rotation:change';
 *   - mudanças feitas aqui vão por 'rotation:set' (CRUD, lista inteira) e
 *     'rotation:select' (escolha por chat), o desktop persiste e devolve.
 *
 * O cache local existe só para a tela abrir preenchida offline; o snapshot do
 * desktop substitui o que estiver aqui, porque é lá que a lista vive.
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
  /** Snapshot vindo do desktop (HTTP no connect ou WS 'rotation:change'). */
  applySync: (config: RotationConfig) => void
  create: (name: string) => ModelRotation
  rename: (id: string, name: string) => void
  updateModels: (id: string, models: SelectedModel[]) => void
  remove: (id: string) => void
  /** Pina a rotação num chat (como escolher um modelo); null desfaz. */
  selectRotation: (sessionId: string | null | undefined, rotationId: string | null) => void
  /** Move a escolha do draft (chat novo) para a sessão criada no 1º envio. */
  adoptRotation: (sessionId: string) => void
}

/** CRUD → desktop (fonte da verdade), que persiste e devolve pelo broadcast. */
function pushRotations(rotations: ModelRotation[]): void {
  const { wsClient } = useConnectionStore.getState()
  try {
    void wsClient.send({ type: 'rotation:set', rotations })
  } catch {
    // Offline: fica no cache local até a próxima conexão, quando o snapshot
    // do desktop (que não tem a mudança) volta a valer.
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
        // cache corrompido — segue vazio
      }
      set({ hydrated: true })

      const { http } = useConnectionStore.getState()
      if (!http) return
      try {
        const res = await http.getRotations()
        if (res.ok && res.data?.config) get().applySync(res.data.config)
      } catch {
        // Offline — fica com o cache local
      }
    },

    applySync: (config) => {
      // O desktop manda o estado inteiro; aqui ele SUBSTITUI o local (ao
      // contrário dos overrides de modelo, onde a escolha local vence): a
      // lista de rotações vive lá, então divergir seria mostrar rotação que
      // não existe mais.
      persist(sanitize(config))
    },

    create: (name) => {
      const rotation: ModelRotation = { id: newRotationId(), name: name.trim() || 'Rotação', models: [] }
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
        // Chats que apontavam para a rotação removida voltam ao modelo
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
        // Offline: sem o desktop saber da escolha, o turno roda no modelo —
        // é o engine de lá que resolve a sequência.
      }
    },

    adoptRotation: (sessionId) => {
      const overrides = { ...get().sessionOverrides }
      const draft = overrides[ROTATION_DRAFT_KEY]
      if (draft === undefined) return
      overrides[sessionId] = draft
      delete overrides[ROTATION_DRAFT_KEY]
      persist({ rotations: get().rotations, sessionOverrides: overrides })
      // O desktop faz o mesmo adopt no store dele quando a sessão nasce por
      // lá; aqui a sessão nasceu no celular, então a escolha é reenviada já
      // com o id definitivo.
      const { wsClient } = useConnectionStore.getState()
      try {
        void wsClient.send({ type: 'rotation:select', rotationId: draft, sessionId })
      } catch {
        // Offline — o desktop reaplica no próximo envio pelo snapshot
      }
    },
  }
})

/** Rotação escolhida para um chat (ou null). Hook reativo para o seletor. */
export function useSessionRotation(sessionId?: string | null): ModelRotation | null {
  const rotations = useModelRotationStore((s) => s.rotations)
  const overrides = useModelRotationStore((s) => s.sessionOverrides)
  const id = overrides[sessionId ?? ROTATION_DRAFT_KEY]
  return (id && rotations.find((r) => r.id === id)) || null
}
