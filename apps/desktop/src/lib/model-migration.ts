import { findCatalogModel, type Catalog } from "@shared/chat"

interface ModelRef {
  providerId: string
  modelId: string
}

/**
 * The successor of a saved model whose id models.dev renamed, or `undefined`
 * when there is nothing to swap (the id still exists, or there is no successor).
 *
 * Preserves the other fields of the object: whoever calls it writes back the same
 * format it read.
 */
export function renamedRef<T extends ModelRef>(catalog: Catalog, ref: T | null | undefined): T | undefined {
  if (!ref) return undefined
  const found = findCatalogModel(catalog, ref.providerId, ref.modelId)
  return found?.renamed ? { ...ref, modelId: found.modelId } : undefined
}

/** Does the saved model exist in the catalog (by id or by renaming)? With the
 *  catalog still empty, the answer is yes: there is no way to know yet. */
export function isKnownModel(catalog: Catalog, ref: ModelRef | null | undefined): boolean {
  if (!ref || Object.keys(catalog).length === 0) return true
  if (!catalog[ref.providerId]) return true // custom provider still loading
  return findCatalogModel(catalog, ref.providerId, ref.modelId) !== undefined
}

/**
 * "provider/model" keys of per-model preferences (e.g.: reasoning level)
 * that need a copy under the new id: returns pairs [old, new].
 */
export function renamedPrefKeys(catalog: Catalog, keys: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const key of keys) {
    const slash = key.indexOf("/")
    if (slash <= 0) continue
    const next = renamedRef(catalog, { providerId: key.slice(0, slash), modelId: key.slice(slash + 1) })
    if (next) pairs.push([key, `${next.providerId}/${next.modelId}`])
  }
  return pairs
}
