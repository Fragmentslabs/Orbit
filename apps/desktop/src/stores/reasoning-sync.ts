import type { ModelReasoningPref, ReasoningPrefsMap } from "@shared/companion"
import { reasoningApi } from "@/src/lib/ipc"
import { useReasoningPrefsStore } from "@/src/stores/reasoning-prefs"

/**
 * Thinking per model with the companions (mobile), in the same design as
 * worker-config-sync: the renderer is the source of truth (the prefs live in
 * its localStorage), pushes the whole map on every change and applies the
 * toggles that come from the phone (WS 'reasoning:select').
 */

function snapshot(): ReasoningPrefsMap {
  return useReasoningPrefsStore.getState().prefs
}

// The reasoning store only changes through these prefs, but the dedup is also what
// prevents the echo — applying what came from the phone generates the same snapshot.
let lastPushed = ""

function push() {
  const prefs = snapshot()
  const serialized = JSON.stringify(prefs)
  if (serialized === lastPushed) return
  lastPushed = serialized
  reasoningApi.sync(prefs)
}

function applyRemote(providerId: string, modelId: string, pref: ModelReasoningPref) {
  if (!providerId || !modelId || !pref || typeof pref.enabled !== "boolean") return
  // Marks it as already sent BEFORE applying: the push fired by the subscribe
  // would see exactly this value and send it back to the phone as if it were new.
  const prefs = useReasoningPrefsStore.getState().prefs
  lastPushed = JSON.stringify({ ...prefs, [`${providerId}/${modelId}`]: pref })
  useReasoningPrefsStore.getState().setPref(`${providerId}/${modelId}`, pref)
}

if (typeof window !== "undefined" && window.ipcRenderer) {
  // Initial state: after a renderer reload the main cache has to
  // be repopulated, otherwise the mobile connects and receives an empty map.
  push()
  useReasoningPrefsStore.subscribe(push)
  reasoningApi.onSelect(({ providerId, modelId, pref }) => {
    applyRemote(providerId, modelId, pref)
  })
}
