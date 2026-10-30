import { create } from "zustand"

const STORAGE_KEY = "orbit-loop-config"

export interface LoopConfig {
  maxIterations: number
}

/**
 * 5 instead of 3: with Loop mode on, the orchestration uses this number in
 * place of its own ceiling (ORCHESTRATION_REVIEW_ROUNDS), so the default must be
 * higher than it for turning Loop on to mean "review more".
 */
const DEFAULTS: LoopConfig = {
  maxIterations: 5,
}

function load(): LoopConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

function save(config: LoopConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

interface LoopConfigState {
  config: LoopConfig
  updateConfig: (patch: Partial<LoopConfig>) => void
  resetConfig: () => void
}

export const useLoopConfigStore = create<LoopConfigState>((set) => ({
  config: load(),
  updateConfig: (patch) =>
    set((state) => {
      const next = { ...state.config, ...patch }
      save(next)
      return { config: next }
    }),
  resetConfig: () => {
    save(DEFAULTS)
    set({ config: DEFAULTS })
  },
}))
