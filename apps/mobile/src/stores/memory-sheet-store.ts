import { create } from 'zustand'

/**
 * Sheet of the memory cited in the conversation — the mobile equivalent of the desktop
 * side panel, where there is no hover and no panel: tapping the chip opens a
 * summary right here, with the path to the full screen.
 *
 * It lives in a store (and not in the component state) because the chip is drawn
 * INSIDE a <Text> of the markdown: a <Modal> cannot be mounted there, and the
 * sheet needs to be unique on the screen — several chips cited in one answer cannot
 * stack several modals.
 */
interface MemorySheetState {
  /** Memory open in the sheet; null = closed. */
  memoryId: string | null
  open: (id: string) => void
  close: () => void
}

export const useMemorySheetStore = create<MemorySheetState>((set) => ({
  memoryId: null,
  open: (id) => set({ memoryId: id }),
  close: () => set({ memoryId: null }),
}))
