import type { WorkerConfigSnapshot } from "@shared/companion"
import { workerConfigApi } from "@/src/lib/ipc"
import { useProviderStore } from "@/src/stores/provider-store"

/**
 * Settings of the delegated modes (model + thinking of the subagent and
 * orchestration workers, and the Vision mode model) shared with the companions.
 * Unlike the per-chat modes, this is global: the phone mirrors the desktop.
 *
 * The renderer is the source of truth (the config lives in its localStorage),
 * pushes on every change and applies whatever comes from the phone.
 */

function snapshot(): WorkerConfigSnapshot {
  const { workerModel, workerReasoning, visionModel, orchestratorModel, orchestratorReasoning, orchestrationSettings } = useProviderStore.getState()
  return {
    workerModel: workerModel ?? null,
    workerReasoning: workerReasoning ?? null,
    visionModel: visionModel ?? null,
    orchestratorModel: orchestratorModel ?? null,
    orchestratorReasoning: orchestratorReasoning ?? null,
    orchestration: orchestrationSettings,
  }
}

// The provider-store changes for much more than this config (catalog, providers):
// without comparing, every fetch would become a pointless broadcast to all the phones.
let lastPushed = ""

function push() {
  const config = snapshot()
  const serialized = JSON.stringify(config)
  if (serialized === lastPushed) return
  lastPushed = serialized
  workerConfigApi.sync(config)
}

if (typeof window !== "undefined" && window.ipcRenderer) {
  push()
  useProviderStore.subscribe(push)
  workerConfigApi.onSet((config) => {
    if (!config || typeof config !== "object") return
    const store = useProviderStore.getState()
    store.setWorkerModel(config.workerModel ?? null)
    store.setWorkerReasoning(config.workerReasoning ?? null)
    store.setVisionModel(config.visionModel ?? null)
    // Absent = the phone does not know the field: keep what is there.
    if ("orchestratorModel" in config) store.setOrchestratorModel(config.orchestratorModel ?? null)
    if ("orchestratorReasoning" in config) store.setOrchestratorReasoning(config.orchestratorReasoning ?? null)
    if (config.orchestration) store.setOrchestrationSettings(config.orchestration)
  })
}
