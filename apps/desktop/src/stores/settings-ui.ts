import { create } from "zustand"

import type { SettingsTab } from "@shared/ui-destinations"

/**
 * Global state of the SettingsDialog: it allows opening from any point of the UI
 * (sidebar menu, PermissionModePicker gear, the chat's `nav` card)
 * already on the right tab.
 */

// The union lives in @shared/ui-destinations because the destination registry has to
// name the tabs; re-exported here for whoever already imported from this module.
export type { SettingsTab }

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
