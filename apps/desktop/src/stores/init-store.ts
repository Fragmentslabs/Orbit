import i18n from "@/src/i18n"
import { create } from "zustand"

import type { InitStage, ProjectArea } from "@shared/memory"
import { initApi } from "@/src/lib/ipc"
import { useProviderStore } from "@/src/stores/provider-store"
import { LOCALE_PROMPT_NAME, useLocaleStore } from "@/src/stores/locale-store"

/**
 * State of /init per directory: feeds the automatic new project card
 * and the /init command. Progress events arrive from main through init:event.
 */

const DISMISSED_KEY = "orbit-init-dismissed"
const DISMISSED_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

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
  /** exploring: subagents finished/total */
  progress?: { done: number; total: number; area?: ProjectArea }
  areas?: ProjectArea[]
  error?: string
}

interface InitState {
  /** Progress per directory (only for inits of this app session) */
  progress: Record<string, InitProgress>
  /** Directories already initialized (init:status cache) */
  initialized: Record<string, boolean>
  /** Cards dismissed by the user (persisted) */
  dismissed: string[]
  _subscribed: boolean

  /** Checks (and caches) whether the project already has init memories */
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
          [directory]: { stage: "error", error: i18n.t("initProject.noModel") },
        },
      }))
      return
    }
    set((state) => ({ progress: { ...state.progress, [directory]: { stage: "scanning" } } }))
    // Without a configured worker the fields go undefined and runProjectInit falls
    // back to providerId/modelId — the main model. Replacing it with codeModel here
    // contradicted the UI and could point to an unavailable model.
    const worker = useProviderStore.getState().workerModel
    await initApi.run({
      directory,
      providerId: selected.providerId,
      modelId: selected.modelId,
      workerProviderId: worker?.providerId,
      workerModelId: worker?.modelId,
      force,
      language: LOCALE_PROMPT_NAME[useLocaleStore.getState().activeLocale],
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

/** Subscribes to main's events only once (lazy — on first use). */
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
      // "done" also ends a cancellation and an analysis that found
      // nothing to write; it only counts as initialized when something was saved.
      initialized:
        event.stage === "done" && (event.areas?.length ?? 0) > 0
          ? { ...state.initialized, [event.directory]: true }
          : state.initialized,
    }))
  })
}

export function subscribeInitEvents() {
  subscribe()
}
