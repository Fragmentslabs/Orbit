import type { ChatModeKey, SessionModeOverrides } from "@shared/companion"
import { sessionModesApi } from "@/src/lib/ipc"
import { useModeOverrides, type OverridableMode } from "@/src/stores/mode-overrides"
import { useSimplePrefs } from "@/src/stores/simple-prefs"
import { useBrainPrefs } from "@/src/stores/brain-prefs"

/**
 * Sync of the active modes PER CHAT with the companions (mobile), in the same
 * design as session-model-prefs: the renderer is the source of truth (the modes
 * live in its localStorage), pushes the whole map to main on every
 * change and applies the toggles that come from the phone.
 *
 * The mode-overrides modes travel along with 'simple' and 'brain', which have their own
 * store — the map is flattened into mode → (sessionId → active). Only what the
 * companions know goes in (`ChatModeKey`), which is what fits in the payload.
 */

/** The draft is per device: "draft" here is a new chat different from the phone's
 *  "draft", so that key stays out of what goes to the companions. */
const DRAFT_KEY = "draft"

function withoutDraft(bySession: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(bySession).filter(([key]) => key !== DRAFT_KEY))
}

/** Only the modes the companions know (`ChatModeKey`) — it is what fits in the
 *  shared payload. "computer" stays out on purpose: the phone does not
 *  turn on the computer control of whoever is in front of it. */
const MODE_OVERRIDE_KEYS: Exclude<OverridableMode, "computer">[] = [
  "search",
  "browser",
  "plan",
  "subagents",
  "orchestra",
  "vision",
]

function snapshot(): SessionModeOverrides {
  const map: SessionModeOverrides = {}
  const overrides = useModeOverrides.getState().overrides
  for (const mode of MODE_OVERRIDE_KEYS) {
    const bySession = overrides[mode]
    if (!bySession) continue
    const shared = withoutDraft(bySession)
    if (Object.keys(shared).length > 0) map[mode] = shared
  }
  // simple keeps only the activations; brain, only the deactivations — the opposite
  // defaults of each stay implicit in the absence of the key, on both sides.
  const simple = useSimplePrefs.getState().overrides
  const simpleEntries = Object.entries(simple).filter(
    ([key, value]) => key !== DRAFT_KEY && value !== undefined,
  )
  if (simpleEntries.length > 0) {
    map.simple = Object.fromEntries(simpleEntries as [string, boolean][])
  }
  const brain = withoutDraft(useBrainPrefs.getState().overrides)
  if (Object.keys(brain).length > 0) map.brain = brain
  return map
}

function push() {
  sessionModesApi.sync(snapshot())
}

/** Applies a toggle coming from a companion in the right store. */
function applyRemote(mode: ChatModeKey, sessionId: string | null, value: boolean) {
  if (mode === "simple") {
    useSimplePrefs.getState().setEnabled(sessionId, value)
    return
  }
  if (mode === "brain") {
    useBrainPrefs.getState().setEnabled(sessionId, value)
    return
  }
  useModeOverrides.getState().setMode(mode, sessionId, value)
}

if (typeof window !== "undefined" && window.ipcRenderer) {
  // Initial state: after a renderer reload the main cache has to
  // be repopulated, otherwise the mobile connects and receives an empty map.
  push()
  useModeOverrides.subscribe(push)
  useSimplePrefs.subscribe(push)
  useBrainPrefs.subscribe(push)
  sessionModesApi.onSelect(({ mode, value, sessionId }) => {
    applyRemote(mode, sessionId ?? null, value)
  })
}
