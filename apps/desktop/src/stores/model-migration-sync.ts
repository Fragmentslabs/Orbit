import type { Catalog } from "@shared/chat"
import { catalogApi } from "@/src/lib/ipc"
import { renamedPrefKeys, renamedRef } from "@/src/lib/model-migration"
import { useModelRotationStore } from "@/src/stores/model-rotation-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { copyReasoningPrefs, reasoningPrefKeys } from "@/src/stores/reasoning-prefs"
import { useSessionModelPrefs } from "@/src/stores/session-model-prefs"

/**
 * Acompanha renomeações de modelo no models.dev. Quando um id some do
 * catálogo e tem sucessor da mesma família (ex: "deepseek-flash" →
 * "deepseek-v4.1-flash"), tudo o que guardava o id velho passa para o novo:
 * modelo de cada chat, default global, recentes, worker, Visão, rotações e o
 * nível de reasoning escolhido para ele.
 *
 * Sem isto, a escolha salva apontava para um modelo inexistente: o seletor
 * mostrava "Selecionar modelo" e, pior, o engine mandava a requisição sem
 * nível de reasoning — o modelo passava a responder sem pensar.
 *
 * Roda a cada troca de catálogo (abertura e atualização em segundo plano).
 * O subscribe do zustand é síncrono, então o default global já está migrado
 * quando o initialize do provider-store valida a escolha logo em seguida —
 * sem cair no "primeiro modelo do primeiro provedor".
 */
function migrate(catalog: Catalog) {
  if (Object.keys(catalog).length === 0) return
  const next = <T extends { providerId: string; modelId: string }>(ref: T | null | undefined) => renamedRef(catalog, ref)

  // Antes de trocar os modelos: as chaves velhas ainda estão lá para copiar.
  copyReasoningPrefs(renamedPrefKeys(catalog, reasoningPrefKeys()))

  const provider = useProviderStore.getState()
  const selected = next(provider.selectedModel)
  if (selected) provider.selectModel(selected.providerId, selected.modelId)
  const worker = next(provider.workerModel)
  if (worker) provider.setWorkerModel(worker)
  const vision = next(provider.visionModel)
  if (vision) provider.setVisionModel(vision)

  useSessionModelPrefs.getState().remap(next)

  const rotations = useModelRotationStore.getState()
  for (const rotation of rotations.rotations) {
    const models = rotation.models.map((model) => next(model) ?? model)
    if (models.some((model, i) => model !== rotation.models[i])) rotations.updateModels(rotation.id, models)
  }
}

useProviderStore.subscribe((state, prev) => {
  if (state.catalog !== prev.catalog) migrate(state.catalog)
})

// A interface carregava o catálogo só ao abrir: depois da atualização em
// segundo plano do main, seguia mostrando modelo e nível do catálogo velho
// enquanto o engine já usava o novo. Recarregar dispara a migração acima.
if (typeof window !== "undefined" && window.ipcRenderer) {
  catalogApi.onUpdated(() => void useProviderStore.getState().reloadCatalog())
}
