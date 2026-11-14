import { useMemo } from "react"
import { usePeersStore } from "@/src/stores/peers-store"

/**
 * The Tools screen is the same on every machine; what differs is which of its actions the
 * machine on screen can do from here. Another desktop runs the OAuth browser, the import
 * dialog, the Nodara/Fracta apps and the "ask Orbit" drafts on ITS side, so those are not
 * offered while it is on screen (the data layer rejects them too — see `mcpApi` in ipc.ts).
 */
export interface ToolsCapabilities {
  /** Another desktop is on screen. */
  remote: boolean
  /** Browser-based authorization of an MCP server. */
  oauth: boolean
  /** Picking a skill file or a folder with a native dialog. */
  pickers: boolean
  /** Creating an item by describing it to a chat that runs on this machine. */
  askOrbit: boolean
  /** The Nodara/Fracta integration cards and the specialists page: local apps and agents. */
  localOnlySections: boolean
}

export const LOCAL_TOOLS: ToolsCapabilities = { remote: false, oauth: true, pickers: true, askOrbit: true, localOnlySections: true }
export const REMOTE_TOOLS: ToolsCapabilities = { remote: true, oauth: false, pickers: false, askOrbit: false, localOnlySections: false }

export function useToolsRemote(): ToolsCapabilities {
  const remote = usePeersStore((s) => s.env !== "local")
  return useMemo(() => (remote ? REMOTE_TOOLS : LOCAL_TOOLS), [remote])
}
