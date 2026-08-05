import { create } from "zustand"

interface BranchData {
  branches: string[]
  current: string
}

interface BranchState {
  byDir: Record<string, BranchData>
  loading: boolean
  checkoutLoading: string | null
  fetchBranches: (repoPath: string) => Promise<void>
  checkoutBranch: (repoPath: string, branch: string) => Promise<{ ok: boolean; error?: string }>
  createBranch: (repoPath: string, branch: string) => Promise<{ ok: boolean; error?: string }>
  commitChanges: (repoPath: string, message: string) => Promise<{ ok: boolean; error?: string }>
}

export const useBranchStore = create<BranchState>((set, get) => ({
  byDir: {},
  loading: false,
  checkoutLoading: null,

  fetchBranches: async (repoPath) => {
    set({ loading: true })
    try {
      const result = await window.ipcRenderer.invoke("git:branches", repoPath) as
        { ok: true; branches: string[]; current: string } | { ok: false; error: string }
      if (result.ok) {
        set((state) => ({
          byDir: { ...state.byDir, [repoPath]: { branches: result.branches, current: result.current } },
        }))
      }
    } finally {
      set({ loading: false })
    }
  },

  checkoutBranch: async (repoPath, branch) => {
    set({ checkoutLoading: branch })
    const result = await window.ipcRenderer.invoke("git:checkout", repoPath, branch) as
      { ok: true } | { ok: false; error: string }
    if (result.ok) {
      await get().fetchBranches(repoPath)
    }
    set({ checkoutLoading: null })
    return result
  },

  createBranch: async (repoPath, branch) => {
    set({ checkoutLoading: branch })
    const result = await window.ipcRenderer.invoke("git:createBranch", repoPath, branch) as
      { ok: true } | { ok: false; error: string }
    if (result.ok) {
      await get().fetchBranches(repoPath)
    }
    set({ checkoutLoading: null })
    return result
  },

  commitChanges: async (repoPath, message) => {
    const result = await window.ipcRenderer.invoke("git:commitAll", repoPath, message) as
      { ok: true } | { ok: false; error: string }
    if (result.ok) {
      await get().fetchBranches(repoPath)
    }
    return result
  },
}))
