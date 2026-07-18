import { create } from 'zustand'

export type WorkspaceMode = 'chat' | 'code'

export type WorkspaceView = 'home' | 'memories' | 'models' | 'usage' | 'tools'

interface WorkspaceState {
  mode: WorkspaceMode
  sidebarOpen: boolean
  sidebarPinned: boolean
  rightPanelOpen: boolean
  view: WorkspaceView

  setMode: (mode: WorkspaceMode) => void
  toggleSidebar: () => void
  openSidebar: () => void
  closeSidebar: () => void
  pinSidebar: (pinned: boolean) => void
  toggleRightPanel: () => void
  setView: (view: WorkspaceView) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  mode: 'chat',
  sidebarOpen: false,
  sidebarPinned: false,
  rightPanelOpen: false,
  view: 'home',

  setMode: (mode) => set({ mode }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  openSidebar: () => set({ sidebarOpen: true }),
  closeSidebar: () => set({ sidebarOpen: false }),
  pinSidebar: (pinned) => set({ sidebarPinned: pinned, sidebarOpen: pinned }),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setView: (view) => set({ view }),
}))
