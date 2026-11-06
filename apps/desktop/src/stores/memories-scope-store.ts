import { create } from "zustand"

export type ViewScope = "chat" | "code" | "all"

/**
 * Which memories the page lists: those of the chat, those of the code or both. `null` = the
 * user did not choose yet, so the page follows the workspace mode (as it always did); the
 * first choice sticks until the app restarts.
 */
interface MemoriesScopeState {
  scope: ViewScope | null
  setScope: (scope: ViewScope) => void
}

export const useMemoriesScope = create<MemoriesScopeState>((set) => ({
  scope: null,
  setScope: (scope) => set({ scope }),
}))
