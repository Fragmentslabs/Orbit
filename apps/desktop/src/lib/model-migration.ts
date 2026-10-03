import { findCatalogModel, type Catalog } from "@shared/chat"

interface ModelRef {
  providerId: string
  modelId: string
}

/**
 * O sucessor de um modelo salvo cujo id o models.dev renomeou, ou `undefined`
 * quando não há o que trocar (o id ainda existe, ou não há sucessor).
 *
 * Preserva os demais campos do objeto: quem chama grava de volta o mesmo
 * formato que leu.
 */
export function renamedRef<T extends ModelRef>(catalog: Catalog, ref: T | null | undefined): T | undefined {
  if (!ref) return undefined
  const found = findCatalogModel(catalog, ref.providerId, ref.modelId)
  return found?.renamed ? { ...ref, modelId: found.modelId } : undefined
}

/** O modelo salvo existe no catálogo (pelo id ou por renomeação)? Com o
 *  catálogo ainda vazio, a resposta é sim: não há como saber ainda. */
export function isKnownModel(catalog: Catalog, ref: ModelRef | null | undefined): boolean {
  if (!ref || Object.keys(catalog).length === 0) return true
  if (!catalog[ref.providerId]) return true // provedor custom ainda carregando
  return findCatalogModel(catalog, ref.providerId, ref.modelId) !== undefined
}

/**
 * Chaves "provedor/modelo" de preferências por modelo (ex: nível de reasoning)
 * que precisam de cópia sob o id novo: devolve pares [velha, nova].
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
