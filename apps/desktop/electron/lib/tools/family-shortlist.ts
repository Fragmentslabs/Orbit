import { isolatedQuery } from '@shared/memory-query'
import { MEMORY_MODEL_DIM, MEMORY_MODEL_ID, embedTexts, workerActive, type TurnEmbedder } from '../memory/embedding'
import { readJson, writeJson } from '../storage'
import type { ToolFamily } from './catalog'
import { semanticFamilies, type FamilyEmbedder, type FamilyPayload, type FamilyStore } from './family-semantic'

/**
 * The app's wiring of the family shortlist: the real worker and the real disk behind the
 * interfaces `family-semantic.ts` tests with fakes.
 */

const FAMILY_VECTORS_KEY = 'tools/family-vectors'

const embedder: FamilyEmbedder = { active: workerActive, embed: embedTexts }

const store: FamilyStore = {
  load: () => readJson<FamilyPayload>(FAMILY_VECTORS_KEY),
  save: (payload) => writeJson(FAMILY_VECTORS_KEY, payload),
}

/**
 * Ids of the families the message points at semantically. Uses the turn's shared query
 * vector and never wakes the worker, so with the model idle, off or missing it returns [].
 */
export async function shortlistFamilies(
  embed: TurnEmbedder,
  text: string,
  families: readonly ToolFamily[],
  alreadyActive: ReadonlySet<string>,
): Promise<string[]> {
  if (!workerActive() || !text.trim()) return []
  const query = await embed(isolatedQuery(text).semantic, { wake: false })
  const hits = await semanticFamilies({
    query,
    families,
    alreadyActive,
    embedder,
    store,
    model: `${MEMORY_MODEL_ID}:${MEMORY_MODEL_DIM}`,
  })
  return hits.map((hit) => hit.id)
}
