import { create } from "zustand"

/**
 * Global state of the RotationDialog: it allows opening from any point of the UI
 * (model selector group, selector footer, Models tab button) with the
 * same deterministic handoff as the SettingsDialog — the modal is mounted once
 * at the app root (RotationDialogHost) and controlled by this store.
 */

interface RotationUiState {
  open: boolean
  /** Rotation to edit on open (undefined = creates a new one if it does not exist) */
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