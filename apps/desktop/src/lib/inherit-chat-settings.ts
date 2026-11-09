import type { SessionMode } from "@shared/chat"
import { lastUsedChat } from "@/src/lib/last-chat"
import { brainEnabledFor, useBrainPrefs } from "@/src/stores/brain-prefs"
import { useModeOverrides, type OverridableMode } from "@/src/stores/mode-overrides"
import { permissionFor, usePermissionPrefs } from "@/src/stores/permission-prefs"
import { sessionModelFor, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { useSessionReasoning } from "@/src/stores/session-reasoning"
import { useSessionStore } from "@/src/stores/session-store"
import { simpleModeFor, useSimplePrefs } from "@/src/stores/simple-prefs"

const MODES: OverridableMode[] = ["search", "browser", "plan", "subagents", "orchestra", "vision"]

/**
 * A chat created ahead of its first message (the creation chats, which open with words already in
 * the composer) has an id, so it would not follow the "new chat inherits the last chat" rule that a
 * draft gets: it would fall back to the app's global defaults. This gives it the same start the
 * draft would have had: the last used chat's model, thinking level, autonomy and modes, copied —
 * each chat stays individual from then on. ("computer" is left out on purpose: controlling the
 * computer is decided by whoever is in front of it, chat by chat.)
 */
export function inheritChatSettings(sessionId: string, mode: SessionMode): void {
  const source = lastUsedChat(useSessionStore.getState().sessions, mode, sessionId)
  const model = sessionModelFor(source?.id ?? null)
  if (model) useSessionModelPrefs.getState().selectModel(sessionId, model.providerId, model.modelId)
  if (!source) return

  const reasoning = useSessionReasoning.getState().overrides[source.id]
  if (reasoning) useSessionReasoning.getState().setPref(sessionId, reasoning)
  useSimplePrefs.getState().setEnabled(sessionId, simpleModeFor(source.id))
  useBrainPrefs.getState().setEnabled(sessionId, brainEnabledFor(source.id))
  usePermissionPrefs.getState().setMode(sessionId, permissionFor(source.id))
  const overrides = useModeOverrides.getState().overrides
  for (const key of MODES) {
    const value = overrides[key]?.[source.id]
    if (value !== undefined) useModeOverrides.getState().setMode(key, sessionId, value)
  }
}
