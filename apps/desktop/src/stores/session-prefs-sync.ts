import type { SessionPrefsSnapshot } from "@shared/companion"
import { sessionPrefsApi } from "@/src/lib/ipc"
import { useSessionReasoning } from "@/src/stores/session-reasoning"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"

/**
 * Thinking and autonomy PER CHAT with the companions (mobile), in the same design
 * as session-models/session-modes: the renderer is the source of truth (the choices
 * live in its localStorage), pushes the snapshot on every change and applies what
 * was chosen on the phone (WS 'session:prefs-select').
 *
 * The 'draft' key stays out: "new chat" on the desktop is another chat than "new
 * chat" on the phone — the same rule as the modes.
 */

const DRAFT_KEY = "draft"

function withoutDraft<T>(bySession: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(bySession).filter(([key]) => key !== DRAFT_KEY))
}

function snapshot(): SessionPrefsSnapshot {
  return {
    reasoning: withoutDraft(useSessionReasoning.getState().overrides),
    permission: withoutDraft(usePermissionPrefs.getState().modes),
  }
}

// Dedup: both stores also change through what comes from the phone — without comparing,
// every application would come back as if it were new.
let lastPushed = ""

function push() {
  const prefs = snapshot()
  const serialized = JSON.stringify(prefs)
  if (serialized === lastPushed) return
  lastPushed = serialized
  sessionPrefsApi.sync(prefs)
}

function applyRemote(data: {
  sessionId?: string | null
  reasoning?: { enabled: boolean; variantId?: string }
  permission?: "ask" | "approve" | "full"
}) {
  // Without a session it is the OTHER device's draft: do not touch the one here.
  if (!data?.sessionId) return
  if (data.permission) {
    usePermissionPrefs.getState().applyRemoteMode(data.sessionId, data.permission)
  }
  if (data.reasoning && typeof data.reasoning.enabled === "boolean") {
    useSessionReasoning.getState().setPref(data.sessionId, {
      enabled: data.reasoning.enabled,
      ...(data.reasoning.variantId ? { variantId: data.reasoning.variantId } : {}),
    })
  }
}

if (typeof window !== "undefined" && window.ipcRenderer) {
  // Initial state: after a renderer reload the main cache has to
  // be repopulated, otherwise the mobile connects and receives an empty snapshot.
  push()
  useSessionReasoning.subscribe(push)
  usePermissionPrefs.subscribe(push)
  sessionPrefsApi.onSelect(applyRemote)
}
