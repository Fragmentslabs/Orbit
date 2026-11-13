import { create } from "zustand"

export type ViewScope = "chat" | "code" | "all"
/** The pages that list chat's and code's data and let the header choose which. */
export type ScopedPage = "memories" | "media"

/**
 * Which data a page lists: the chat's, the code's or both. A page the user has not chosen
 * for yet is absent here, so it follows the workspace mode (as the pages always did); the
 * first choice sticks until the app restarts.
 */
interface ViewScopeState {
  scopes: Partial<Record<ScopedPage, ViewScope>>
  setScope: (page: ScopedPage, scope: ViewScope) => void
}

export const useViewScopeStore = create<ViewScopeState>((set) => ({
  scopes: {},
  setScope: (page, scope) => set((state) => ({ scopes: { ...state.scopes, [page]: scope } })),
}))

/** The scope of a page, and how to change it. `fallback` is the workspace mode. */
export function useViewScope(page: ScopedPage, fallback: "chat" | "code"): [ViewScope, (scope: ViewScope) => void] {
  const chosen = useViewScopeStore((s) => s.scopes[page])
  const setScope = useViewScopeStore((s) => s.setScope)
  return [chosen ?? fallback, (scope) => setScope(page, scope)]
}
