import type { WorkerConfigSnapshot } from "@shared/companion"
import { workerConfigApi } from "@/src/lib/ipc"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { useProviderStore } from "@/src/stores/provider-store"

/**
 * Config dos modos delegados (modelo + thinking dos workers de subagentes e
 * orquestração, e modelo do modo Visão) com os companions. Diferente dos modos
 * por chat, isto é global: o celular espelha o desktop.
 *
 * O renderer é a fonte da verdade (a config vive no localStorage dele), empurra
 * a cada mudança e aplica o que vier do celular.
 */

function snapshot(): WorkerConfigSnapshot {
  const { workerModel, workerReasoning, visionModel } = useProviderStore.getState()
  return {
    workerModel: workerModel ?? null,
    workerReasoning: workerReasoning ?? null,
    visionModel: visionModel ?? null,
  }
}

// O provider-store muda por muito mais que esta config (catálogo, provedores):
// sem comparar, cada fetch viraria um broadcast à toa para todos os celulares.
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
    // O campo "Modelo dos subagentes" das preferências espelha o workerModel
    // (escolher ali grava nos dois). Sem atualizar aqui, mudar o modelo pelo
    // celular deixava o painel do desktop exibindo o modelo antigo, enquanto a
    // execução já usava o novo.
    useModelModePrefs.getState().setSubagentModel(config.workerModel ?? null)
  })
}
