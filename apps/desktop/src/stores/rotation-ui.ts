import { create } from "zustand"

/**
 * Estado global do RotationDialog: permite abrir de qualquer ponto da UI
 * (grupo do seletor de modelo, footer do seletor, botão da aba Models) com o
 * mesmo handoff determinístico do SettingsDialog — o modal é montado uma vez
 * na raiz do app (RotationDialogHost) e controlado por este store.
 */

interface RotationUiState {
  open: boolean
  /** Rotação a editar ao abrir (undefined = cria nova se não existir) */
  rotationId: string | null
  openRotation: (rotationId?: string | null) => void
  setOpen: (open: boolean) => void
}

export const useRotationUi = create<RotationUiState>((set) => ({
  open: false,
  rotationId: null,
  openRotation: (rotationId = null) => set({ open: true, rotationId }),
  setOpen: (open) => set({ open }),
}))