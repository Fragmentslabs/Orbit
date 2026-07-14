import type { Memory } from '../../../shared/memory'
import { StorageKeys } from '../../../shared/chat'
import { listKeys, readJson, removeJson, removeText, readText, writeJson, writeText } from '../storage'

/**
 * Persistência das memórias sobre o storage JSON atômico:
 * - memory/items/<id>.json  → fonte da verdade (um arquivo por memória)
 * - memory/_index.json      → cache com todas as memórias (rebuildável)
 * - memory/docs/<id>.md     → documento markdown opcional anexado
 *
 * Toda mutação passa por uma fila serializada — o índice é read-modify-write
 * e duas sessões podem salvar ao mesmo tempo.
 */

const docKey = (id: string) => `memory/docs/${id}`

let indexCache: Memory[] | null = null
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => {})
  return next
}

async function persistIndex(index: Memory[]): Promise<void> {
  indexCache = index
  await writeJson(StorageKeys.memoryIndex, index)
}

/** Reconstrói o índice varrendo os itens — recuperação de índice ausente/corrompido. */
export async function rebuildIndex(): Promise<Memory[]> {
  const keys = await listKeys(StorageKeys.memoryItemsPrefix)
  const items = await Promise.all(keys.map((key) => readJson<Memory>(key)))
  const index = items.filter((m): m is Memory => m != null)
  await persistIndex(index)
  return index
}

/** Índice completo em memória (lazy). O main é o único escritor. */
export async function getIndex(): Promise<Memory[]> {
  if (indexCache) return indexCache
  try {
    const stored = await readJson<Memory[]>(StorageKeys.memoryIndex)
    if (Array.isArray(stored)) {
      indexCache = stored
      return stored
    }
  } catch {
    // índice corrompido — reconstrói abaixo
  }
  return rebuildIndex()
}

export async function get(id: string): Promise<Memory | null> {
  const index = await getIndex()
  return index.find((m) => m.id === id) ?? null
}

/** Cria/atualiza uma memória (item + índice), serializado. */
export function put(memory: Memory): Promise<void> {
  return enqueue(async () => {
    const index = await getIndex()
    const exists = index.some((m) => m.id === memory.id)
    const next = exists ? index.map((m) => (m.id === memory.id ? memory : m)) : [...index, memory]
    await writeJson(StorageKeys.memory(memory.id), memory)
    await persistIndex(next)
  })
}

/**
 * Remove uma memória em cascata: item, doc anexado e a referência em
 * relatedIds das demais. Retorna as memórias que tiveram backlinks ajustados.
 */
export function remove(id: string): Promise<Memory[]> {
  return enqueue(async () => {
    const index = await getIndex()
    const touched: Memory[] = []
    const next: Memory[] = []
    for (const m of index) {
      if (m.id === id) continue
      if (m.relatedIds.includes(id)) {
        const updated = { ...m, relatedIds: m.relatedIds.filter((r) => r !== id) }
        await writeJson(StorageKeys.memory(updated.id), updated)
        touched.push(updated)
        next.push(updated)
      } else {
        next.push(m)
      }
    }
    await removeJson(StorageKeys.memory(id))
    await removeText(docKey(id))
    await persistIndex(next)
    return touched
  })
}

export function readDoc(id: string): Promise<string | null> {
  return readText(docKey(id))
}

export function writeDoc(id: string, markdown: string): Promise<void> {
  return writeText(docKey(id), markdown)
}
