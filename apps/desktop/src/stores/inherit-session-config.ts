import { permissionFor, usePermissionPrefs } from "@/src/stores/permission-prefs"
import { sessionModelFor, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { sessionReasoningFor, useSessionReasoning } from "@/src/stores/session-reasoning"

/**
 * A new session that continues what another was doing (a fork, /init) keeps the model,
 * the thinking level and the permission of the one it came from: it swaps the context, not
 * the configuration. `fromSessionId` undefined = the draft (what the input shows before the
 * first send). Without this the new session fell into the provider's GLOBAL default — another
 * model than the one the person had selected.
 */
export function inheritSessionConfig(fromSessionId: string | null | undefined, toSessionId: string): void {
  const model = sessionModelFor(fromSessionId)
  if (model) {
    useSessionModelPrefs.getState().selectModel(toSessionId, model.providerId, model.modelId)
  }
  const reasoning = sessionReasoningFor(fromSessionId, model?.providerId, model?.modelId)
  if (reasoning) useSessionReasoning.getState().setPref(toSessionId, reasoning)
  usePermissionPrefs.getState().applyRemoteMode(toSessionId, permissionFor(fromSessionId))
}
