import { permissionFor, usePermissionPrefs } from "@/src/stores/permission-prefs"
import { sessionModelFor, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { sessionReasoningFor, useSessionReasoning } from "@/src/stores/session-reasoning"

/**
 * A new session that continues what another was doing (a fork, /init) keeps the model,
 * the thinking level and the permission of the one it came from: it swaps the context, not
 * the configuration. `fromSessionId` undefined = the draft (what the input shows before the
 * first send). Without this the new session fell into the provider's GLOBAL default — another
 * model than the one the person had selected.
 *
 * READ FIRST, CREATE AFTER. What a draft "shows" is its own choice, else the choice of the most
 * recent chat (see sessionModelFor). Creating the new session makes IT the most recent chat — one
 * with no choice of its own — so reading the draft's configuration after the creation answers with
 * the global default instead of what was on screen. Whoever opens the session must capture the
 * configuration BEFORE creating it, and apply it to the new id afterwards.
 */
export function captureSessionConfig(fromSessionId: string | null | undefined): (toSessionId: string) => void {
  const model = sessionModelFor(fromSessionId)
  const reasoning = sessionReasoningFor(fromSessionId, model?.providerId, model?.modelId)
  const permission = permissionFor(fromSessionId)
  return (toSessionId) => {
    if (model) useSessionModelPrefs.getState().selectModel(toSessionId, model.providerId, model.modelId)
    if (reasoning) useSessionReasoning.getState().setPref(toSessionId, reasoning)
    usePermissionPrefs.getState().applyRemoteMode(toSessionId, permission)
  }
}

/** Capture and apply in one step: right for a session that already exists (a fork), where nothing is created in between. */
export function inheritSessionConfig(fromSessionId: string | null | undefined, toSessionId: string): void {
  captureSessionConfig(fromSessionId)(toSessionId)
}
