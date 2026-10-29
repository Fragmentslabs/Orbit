import { create } from "zustand"

import type { SettingsTab } from "@shared/ui-destinations"

/**
 * Estado global do SettingsDialog: permite abrir de qualquer ponto da UI
 * (menu da sidebar, engrenagem do PermissionModePicker, cartão `nav` do chat)
 * já na aba certa.
 */

// A união mora em @shared/ui-destinations porque o registro de destinos precisa
// nomear as abas; reexportada aqui para quem já importava deste módulo.
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
