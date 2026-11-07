import { create } from "zustand"

/** A section of the Tools page. */
export type ToolsSection = "integrations" | "mcp" | "skills" | "hooks" | "specialists"

/**
 * Lets something outside the Tools page (the agent selector) open it on a given section. The
 * page reads the request when it mounts and clears it, so a later visit starts where it always did.
 */
interface ToolsNavState {
  requested: ToolsSection | null
  request: (section: ToolsSection) => void
  consume: () => ToolsSection | null
}

export const useToolsNavStore = create<ToolsNavState>((set, get) => ({
  requested: null,
  request: (section) => set({ requested: section }),
  consume: () => {
    const section = get().requested
    if (section) set({ requested: null })
    return section
  },
}))
