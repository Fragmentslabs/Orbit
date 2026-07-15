import type { ModelsSnapshot } from '@shared/models'
import { getCatalog } from '../catalog'
import { getAAModels, hasAAKey } from './artificial-analysis'
import { getOpenRouterModels } from './openrouter'
import { buildOrbitModels } from './ranking'

/**
 * Ponto de entrada do catálogo unificado da aba Models. As fontes têm cache
 * próprio em disco (24h); aqui só mantemos o snapshot montado em memória.
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

/** Invalida o snapshot em memória (ex: depois de salvar a chave da AA). */
export function invalidateModelsSnapshot() {
  snapshot = null
}
