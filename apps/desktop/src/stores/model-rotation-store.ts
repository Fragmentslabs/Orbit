import { create } from "zustand"

import type { ModelRotation, RotationConfig } from "@shared/chat"
import type { SelectedModel } from "@/src/stores/provider-store"
import { rotationApi } from "@/src/lib/ipc"

/**
 * Rotação de modelos — listas nomeadas de modelos (1..4 slots) para o engine
 * tentar em sequência quando um falhar no início do turno (rate-limit, rede,
 * moderação). Não há toggle global nem rotação "ativa": a rotação é apenas
 * criada/gerenciada aqui e ESCOLHIDA POR CHAT no seletor de modelo, como se
 * fosse um modelo (`sessionOverrides` = sessão → rotação; "draft" = chat
 * novo antes do primeiro envio). Escolher um modelo no seletor limpa a
 * rotação do chat (e vice-versa).
 *
 * O estado vive no localStorage (mesmo padrão de session-model-prefs) e é
 * empurrado para o main via `rotation:sync` — é o main quem resolve a
 * sequência do turno no momento da chamada (electron/lib/model-rotation.ts).
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
        // Shape v1 tinha enabled/activeId — ignorados. A escolha por chat é
        // lida do que já estiver salvo (ou vazio).
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
    // estado corrompido — recomeça sem rotações
  }
  return { rotations: [], sessionOverrides: {} }
}

interface ModelRotationState extends RotationConfig {
  create: (name: string) => ModelRotation
  rename: (id: string, name: string) => void
  updateModels: (id: string, models: SelectedModel[]) => void
  remove: (id: string) => void
  /** Pina a rotação num chat (como escolher um modelo); rotationId null desfaz. */
  selectRotation: (sessionId: string | null | undefined, rotationId: string | null) => void
  /** Move a escolha do draft (chat novo) para a sessão criada no 1º envio. */
  adoptRotation: (sessionId: string) => void
  /** Substitui a lista inteira — usado pelo CRUD vindo de um companion
   *  (`rotation:set`), que manda o estado completo em vez de um verbo por
   *  operação. Escolhas por chat que apontam para rotações que sumiram são
   *  descartadas, como no `remove`. */
  replaceAll: (rotations: ModelRotation[]) => void
}

/** Sincroniza o estado inteiro com o main (cache do engine). */
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
      const rotation: ModelRotation = { id: newRotationId(), name: name.trim() || "Rotação", models: [] }
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
        // Sessões que apontavam para a rotação removida voltam ao default
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

// Repopula o cache do main após reload do renderer (mesma mecânica do
// sessionModelsApi no session-model-prefs) e aplica o que foi feito nos
// companions: o renderer é a fonte da verdade (o estado vive no
// localStorage dele), então a escolha/CRUD do celular é persistida aqui e
// volta a todos pelo `rotation:sync` → broadcast.
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