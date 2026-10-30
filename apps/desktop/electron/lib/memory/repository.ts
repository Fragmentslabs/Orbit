import type { Memory } from '@shared/memory'
import { StorageKeys } from '@shared/chat'
import { listKeys, readJson, removeJson, removeText, readText, writeJson, writeText } from '../storage'

/**
 * Memory persistence on top of the atomic JSON storage:
 * - memory/items/<id>.json  → source of truth (one file per memory)
 * - memory/_index.json      → cache with every memory (rebuildable)
 * - memory/docs/<id>.md     → optional attached markdown document
 *
 * Every mutation goes through a serialized queue — the index is read-modify-write
 * and two sessions can save at the same time.
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

/** Rebuilds the index by scanning the items — recovery from a missing/corrupted index. */
export async function rebuildIndex(): Promise<Memory[]> {
  const keys = await listKeys(StorageKeys.memoryItemsPrefix)
  const items = await Promise.all(keys.map((key) => readJson<Memory>(key)))
  const index = items.filter((m): m is Memory => m != null)
  await persistIndex(index)
  return index
}

/** Full in-memory index (lazy). The main process is the only writer. */
export async function getIndex(): Promise<Memory[]> {
  if (indexCache) return indexCache
  try {
    const stored = await readJson<Memory[]>(StorageKeys.memoryIndex)
    if (Array.isArray(stored)) {
      indexCache = stored
      return stored
    }
  } catch {
    // corrupted index — rebuild below
  }
  return rebuildIndex()
}

export async function get(id: string): Promise<Memory | null> {
  const index = await getIndex()
  return index.find((m) => m.id === id) ?? null
}

/** Creates/updates a memory (item + index), serialized. */
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
 * Several memories in a single index write. Search marks usage on all the
 * results at once; with put() one by one, each result rewrote the whole
 * index — a search with 12 results meant 12 index writes in sequence.
 */
export function putMany(memories: Memory[]): Promise<void> {
  if (memories.length === 0) return Promise.resolve()
  return enqueue(async () => {
    const byId = new Map(memories.map((m) => [m.id, m]))
    const index = await getIndex()
    const next = index.map((m) => byId.get(m.id) ?? m)
    for (const m of memories) {
      if (!index.some((existing) => existing.id === m.id)) next.push(m)
      await writeJson(StorageKeys.memory(m.id), m)
    }
    await persistIndex(next)
  })
}

/**
 * Removes a memory in cascade: item, attached doc and the reference in
 * relatedIds of the others. Returns the memories whose backlinks were adjusted.
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
