import { create } from "zustand"
import type { PermissionMode } from "@shared/chat"

const MODE_KEY = "orbit-permission-mode"

function loadMode(): PermissionMode {
  const stored = localStorage.getItem(MODE_KEY)
  return stored === "approve" || stored === "full" ? stored : "ask"
}

interface PermissionPrefsState {
  mode: PermissionMode
  setMode: (mode: PermissionMode) => void
}

export const usePermissionPrefs = create<PermissionPrefsState>((set) => ({
  mode: loadMode(),
  setMode: (mode) => {
    localStorage.setItem(MODE_KEY, mode)
    set({ mode })
  },
}))
