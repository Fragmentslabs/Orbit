import type { Catalog } from "@shared/chat"
import { catalogApi } from "@/src/lib/ipc"
import { renamedPrefKeys, renamedRef } from "@/src/lib/model-migration"
import { useModelRotationStore } from "@/src/stores/model-rotation-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { copyReasoningPrefs, reasoningPrefKeys } from "@/src/stores/reasoning-prefs"
import { useSessionModelPrefs } from "@/src/stores/session-model-prefs"

/**
 * Follows model renames in models.dev. When an id disappears from the
 * catalog and has a successor of the same family (e.g.: "deepseek-flash" →
 * "deepseek-v4.1-flash"), everything that kept the old id moves to the new one:
 * each chat's model, the global default, recents, worker, Vision, rotations and the
 * reasoning level chosen for it.
 *
 * Without this, the saved choice pointed to a nonexistent model: the selector
 * showed "Select model" and, worse, the engine sent the request without a
 * reasoning level — the model started answering without thinking.
 *
 * It runs on every catalog change (startup and background update).
 * The zustand subscribe is synchronous, so the global default is already migrated
 * when the provider-store initialize validates the choice right after —
 * without falling into the "first model of the first provider".
 */
function migrate(catalog: Catalog) {
  if (Object.keys(catalog).length === 0) return
  const next = <T extends { providerId: string; modelId: string }>(ref: T | null | undefined) => renamedRef(catalog, ref)

  // Before swapping the models: the old keys are still there to copy.
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

// The interface only loaded the catalog on startup: after main's background
// update, it kept showing the model and level from the old catalog
// while the engine was already using the new one. Reloading triggers the migration above.
if (typeof window !== "undefined" && window.ipcRenderer) {
  catalogApi.onUpdated(() => void useProviderStore.getState().reloadCatalog())
}
