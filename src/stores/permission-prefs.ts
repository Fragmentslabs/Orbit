import { create } from "zustand"
import type {
  PermissionMode,
  PermissionThresholds,
  PermissionThresholdsByMode,
  RiskLevel,
  SensitivityLevel,
} from "@/shared/chat"
import { DEFAULT_PERMISSION_THRESHOLDS } from "@/shared/chat"

/**
 * Modo de permissões global (code-mode e workers), persistido em localStorage.
 * "ask" pergunta antes de ações sensíveis; "approve" dá autonomia com deny-list
 * dura; "full" é irrestrito. Thresholds por modo são ajustáveis nas Settings.
 */

const MODE_KEY = "orbit-permission-mode"
const THRESHOLDS_KEY = "orbit-permission-thresholds"

function loadMode(): PermissionMode {
  const stored = localStorage.getItem(MODE_KEY)
  return stored === "approve" || stored === "full" ? stored : "ask"
}

function cloneDefaults(): PermissionThresholdsByMode {
  return {
    ask: { ...DEFAULT_PERMISSION_THRESHOLDS.ask },
    approve: { ...DEFAULT_PERMISSION_THRESHOLDS.approve },
    full: { ...DEFAULT_PERMISSION_THRESHOLDS.full },
  }
}

function loadThresholds(): PermissionThresholdsByMode {
  try {
    const raw = localStorage.getItem(THRESHOLDS_KEY)
    if (!raw) return cloneDefaults()
    const parsed = JSON.parse(raw) as Partial<PermissionThresholdsByMode>
    const base = cloneDefaults()
    for (const mode of ["ask", "approve", "full"] as PermissionMode[]) {
      const t = parsed[mode]
      if (t) base[mode] = { terminalAuto: t.terminalAuto ?? base[mode].terminalAuto, decisionsAuto: t.decisionsAuto ?? base[mode].decisionsAuto }
    }
    return base
  } catch {
    return cloneDefaults()
  }
}

interface PermissionPrefsState {
  mode: PermissionMode
  thresholds: PermissionThresholdsByMode
  setMode: (mode: PermissionMode) => void
  setThreshold: (mode: PermissionMode, field: keyof PermissionThresholds, value: RiskLevel | SensitivityLevel) => void
  resetThresholds: () => void
  thresholdsFor: (mode: PermissionMode) => PermissionThresholds
}

export const usePermissionPrefs = create<PermissionPrefsState>((set, get) => ({
  mode: loadMode(),
  thresholds: loadThresholds(),
  setMode: (mode) => {
    localStorage.setItem(MODE_KEY, mode)
    set({ mode })
  },
  setThreshold: (mode, field, value) => {
    set((state) => {
      const next: PermissionThresholdsByMode = {
        ...state.thresholds,
        [mode]: { ...state.thresholds[mode], [field]: value },
      }
      localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(next))
      return { thresholds: next }
    })
  },
  resetThresholds: () => {
    const defaults = cloneDefaults()
    localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(defaults))
    set({ thresholds: defaults })
  },
  thresholdsFor: (mode) => get().thresholds[mode] ?? DEFAULT_PERMISSION_THRESHOLDS[mode],
}))
