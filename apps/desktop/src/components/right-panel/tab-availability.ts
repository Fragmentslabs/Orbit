import { parseRemoteSessionId } from "@shared/peers"
import type { TabType } from "@/src/stores/panel-store"

/**
 * Which panel tabs make sense for the chat on screen.
 *
 * On another desktop the panel keeps what works through the peers connection
 * (conversations, the media registry, pieces opened by events, the project files
 * through the "files" grant) and drops what needs THIS machine: terminals, running
 * processes, the browser, local diffs, pinned fragments. "folders" stays as a type
 * but the panel renders the remote file browser for it.
 */
const LOCAL_ONLY: ReadonlySet<TabType> = new Set(["terminal", "process", "browser", "diff", "fragment"])

/** Tabs that only exist pointing at something; never offered empty. */
const NEVER_EMPTY: ReadonlySet<TabType> = new Set([
  "artifact", "source", "document", "process", "diff", "motion", "design", "slides", "memory", "routine",
])

/** The tab types the "+" screen offers on a paired desktop (the rest is local-only). */
const REMOTE_SELECTABLE: ReadonlySet<TabType> = new Set(["chat", "media", "sources", "folders"])

/** Types the selector offers, for the local machine or a paired desktop. */
export function isSelectableTab(type: TabType, mode: "chat" | "code", remote = false): boolean {
  if (NEVER_EMPTY.has(type)) return false
  if (remote) return REMOTE_SELECTABLE.has(type)
  if (mode === "code") return true
  // "browser" enters chat: the browser does not depend on a working folder.
  return type === "chat" || type === "media" || type === "sources" || type === "browser" || type === "fragment"
}

/**
 * Whether a tab already in the store can be shown on this side. A pinned tab follows
 * the person across chats, so it can come from the other environment: a local
 * terminal must not show over a remote chat, and a remote conversation cannot be
 * rendered by the local chat view.
 */
export function isTabAvailable(tab: { type: TabType; sessionId?: string }, remote: boolean): boolean {
  if (remote) return !LOCAL_ONLY.has(tab.type)
  return !(tab.type === "chat" && parseRemoteSessionId(tab.sessionId))
}

/** Whether the remote file browser can be offered (peer online and the "files" grant given). */
export function canBrowseRemoteFiles(peer: { online: boolean; grants: { files: boolean } } | undefined): boolean {
  return !!peer && peer.online && peer.grants.files
}
