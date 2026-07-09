import { create } from "zustand"
import type { PermissionMode } from "@/shared/chat"

/**
 * Modo de permissões global (code-mode e workers), persistido em localStorage.
 * "ask" pergunta antes de ações sensíveis; "approve" dá autonomia com deny-list
 * dura; "full" é irrestrito.
 */

const STORAGE_KEY = "orbit-permission-mode"

function load(): PermissionMode {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === "approve" || stored === "full" ? stored : "ask"
}

interface PermissionPrefsState {
  mode: PermissionMode
  setMode: (mode: PermissionMode) => void
}

export const usePermissionPrefs = create<PermissionPrefsState>((set) => ({
  mode: load(),
  setMode: (mode) => {
    localStorage.setItem(STORAGE_KEY, mode)
    set({ mode })
  },
}))
