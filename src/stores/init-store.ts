import { create } from "zustand"

import type { InitStage, ProjectArea } from "@/shared/memory"
import { initApi } from "@/src/lib/ipc"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { useProviderStore } from "@/src/stores/provider-store"

/**
 * Estado do /init por diretório: alimenta o card automático de projeto novo
 * e o comando /init. Eventos de progresso chegam do main via init:event.
 */

const DISMISSED_KEY = "orbit-init-dismissed"
const DISMISSED_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 dias

function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    if (!raw) return []
    const stored: Record<string, number> = JSON.parse(raw)
    const now = Date.now()
    const valid = Object.entries(stored)
      .filter(([, ts]) => now - ts < DISMISSED_TTL_MS)
      .map(([dir]) => dir)
    if (valid.length !== Object.keys(stored).length) {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(
        Object.fromEntries(valid.map((d) => [d, stored[d]])),
      ))
    }
    return valid
  } catch {
    return []
  }
}

function saveDismissed(dirs: string[]) {
  localStorage.setItem(DISMISSED_KEY, JSON.stringify(
    Object.fromEntries(dirs.map((d) => [d, Date.now()])),
  ))
}

export interface InitProgress {
  stage: InitStage
  /** exploring: subagents concluídos/total */
  progress?: { done: number; total: number; area?: ProjectArea }
  areas?: ProjectArea[]
  error?: string
}

interface InitState {
  /** Progresso por diretório (só de inits desta sessão do app) */
  progress: Record<string, InitProgress>
  /** Diretórios já inicializados (cache do init:status) */
  initialized: Record<string, boolean>
  /** Cards dispensados pelo usuário (persistido) */
  dismissed: string[]
  _subscribed: boolean

  /** Consulta (e cacheia) se o projeto já tem memórias de init */
  check: (directory: string) => Promise<boolean>
  run: (directory: string, force?: boolean) => Promise<void>
  dismiss: (directory: string) => void
  clearProgress: (directory: string) => void
}

export const useInitStore = create<InitState>((set, get) => ({
  progress: {},
  initialized: {},
  dismissed: loadDismissed(),
  _subscribed: false,

  check: async (directory) => {
    const cached = get().initialized[directory]
    if (cached !== undefined) return cached
    const status = await initApi.status(directory)
    set((state) => ({ initialized: { ...state.initialized, [directory]: status.initialized } }))
    if (status.running) {
      set((state) => ({ progress: { ...state.progress, [directory]: { stage: "scanning" } } }))
    }
    return status.initialized
  },

  run: async (directory, force) => {
    subscribe()
    const selected = useProviderStore.getState().selectedModel
    if (!selected) {
      set((state) => ({
        progress: {
          ...state.progress,
          [directory]: { stage: "error", error: "Nenhum modelo selecionado — configure um provedor." },
        },
      }))
      return
    }
    set((state) => ({ progress: { ...state.progress, [directory]: { stage: "scanning" } } }))
    let worker = useProviderStore.getState().workerModel
    if (!worker) {
      const codeModel = useModelModePrefs.getState().codeModel
      if (codeModel) worker = codeModel
    }
    await initApi.run({
      directory,
      providerId: selected.providerId,
      modelId: selected.modelId,
      workerProviderId: worker?.providerId,
      workerModelId: worker?.modelId,
      force,
    })
  },

  dismiss: (directory) => {
    set((state) => {
      const dismissed = [...new Set([...state.dismissed, directory])]
      saveDismissed(dismissed)
      return { dismissed }
    })
  },

  clearProgress: (directory) => {
    set((state) => {
      const progress = { ...state.progress }
      delete progress[directory]
      return { progress }
    })
  },
}))

/** Assina os eventos do main uma única vez (lazy — no primeiro uso). */
function subscribe() {
  if (useInitStore.getState()._subscribed) return
  useInitStore.setState({ _subscribed: true })
  initApi.onEvent((event) => {
    useInitStore.setState((state) => ({
      progress: {
        ...state.progress,
        [event.directory]: {
          stage: event.stage,
          progress: event.progress,
          areas: event.areas,
          error: event.error,
        },
      },
      initialized:
        event.stage === "done"
          ? { ...state.initialized, [event.directory]: true }
          : state.initialized,
    }))
  })
}

export function subscribeInitEvents() {
  subscribe()
}
