import { create } from "zustand"

interface BranchData {
  branches: string[]
  current: string
}

export interface BranchSyncInfo {
  current: string | null
  defaultBranch: string | null
  ahead: number
  behind: number
  upstream: string | null
  hasRemote: boolean
  dirty: boolean
}

export type SyncErrorKind = 'auth' | 'noUpstream' | 'noRemote' | 'other'

export type SyncResult =
  | { ok: true; created?: boolean }
  | { ok: false; message: string; kind: SyncErrorKind }

interface BranchState {
  byDir: Record<string, BranchData>
  loading: boolean
  checkoutLoading: string | null
  infoByDir: Record<string, BranchSyncInfo>
  syncBusyDir: string | null
  fetchBranches: (repoPath: string) => Promise<void>
  checkoutBranch: (repoPath: string, branch: string) => Promise<{ ok: boolean; error?: string }>
  createBranch: (repoPath: string, branch: string) => Promise<{ ok: boolean; error?: string }>
  commitChanges: (repoPath: string, message: string) => Promise<{ ok: boolean; error?: string }>
  refreshInfo: (repoPath: string) => Promise<void>
  pullChanges: (repoPath: string) => Promise<SyncResult>
  pushChanges: (repoPath: string) => Promise<SyncResult>
}

export const useBranchStore = create<BranchState>((set, get) => ({
  byDir: {},
  loading: false,
  checkoutLoading: null,
  infoByDir: {},
  syncBusyDir: null,

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

  refreshInfo: async (repoPath) => {
    const result = await window.ipcRenderer.invoke("git:branchInfo", repoPath) as
      { ok: true; info: BranchSyncInfo } | { ok: false; error: string }
    if (result.ok) {
      set((state) => ({
        infoByDir: { ...state.infoByDir, [repoPath]: result.info },
      }))
    }
  },

  pullChanges: async (repoPath) => {
    set({ syncBusyDir: repoPath })
    try {
      const result = await window.ipcRenderer.invoke("git:pull", repoPath) as SyncResult
      if (result.ok) {
        await Promise.all([get().fetchBranches(repoPath), get().refreshInfo(repoPath)])
      }
      return result
    } finally {
      set({ syncBusyDir: null })
    }
  },

  pushChanges: async (repoPath) => {
    set({ syncBusyDir: repoPath })
    try {
      const result = await window.ipcRenderer.invoke("git:push", repoPath) as SyncResult
      if (result.ok) {
        await Promise.all([get().fetchBranches(repoPath), get().refreshInfo(repoPath)])
      }
      return result
    } finally {
      set({ syncBusyDir: null })
    }
  },
}))
