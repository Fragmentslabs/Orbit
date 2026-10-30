import type { ModelsSnapshot } from '@shared/models'
import { getCatalog } from '../catalog'
import { getAAModels, hasAAKey } from './artificial-analysis'
import { getOpenRouterModels } from './openrouter'
import { buildOrbitModels } from './ranking'

/**
 * Entry point of the unified catalog for the Models tab. Each source keeps its
 * own cache on disk (24h); here we only hold the assembled snapshot in memory.
 */

let snapshot: ModelsSnapshot | null = null

export async function getModelsSnapshot(force = false): Promise<ModelsSnapshot> {
  if (snapshot && !force) return snapshot

  const [openRouter, aa, catalog, aaKey] = await Promise.all([
    getOpenRouterModels(force),
    getAAModels(force),
    getCatalog(),
    hasAAKey(),
  ])

  snapshot = {
    models: buildOrbitModels({ openRouter, aa, catalog }),
    updatedAt: Date.now(),
    hasAAKey: aaKey,
  }
  return snapshot
}

/** Invalidates the in-memory snapshot (e.g. after saving the AA key). */
export function invalidateModelsSnapshot() {
  snapshot = null
}
