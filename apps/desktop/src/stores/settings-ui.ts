import { create } from "zustand"

/**
 * Estado global do SettingsDialog: permite abrir de qualquer ponto da UI
 * (menu da sidebar, engrenagem do PermissionModePicker) já na aba certa.
 */

export type SettingsTab = "providers" | "autonomy" | "mcp-skills" | "data" | "howto" | "appearance" | "notifications" | "system"

interface SettingsUiState {
  open: boolean
  tab: SettingsTab
  openSettings: (tab?: SettingsTab) => void
  setOpen: (open: boolean) => void
}

export const useSettingsUi = create<SettingsUiState>((set) => ({
  open: false,
  tab: "providers",
  openSettings: (tab = "providers") => set({ open: true, tab }),
  setOpen: (open) => set({ open }),
}))
