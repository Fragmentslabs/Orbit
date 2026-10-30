import type { ImageResult } from './types'

/**
 * The results of the last search, by id. The agent chooses by the short id
 * (`wc:123`, `ov:<uuid>`) and the import needs the address and the credit: keeping
 * that here prevents the MODEL from typing a URL and a license — which is where a
 * transcription mistake would make an image come in with the wrong credit.
 */

const TTL_MS = 2 * 60 * 60 * 1000
const MAX_ENTRIES = 600

const entries = new Map<string, { result: ImageResult; at: number }>()

export function rememberResults(results: ImageResult[], now = Date.now()): void {
  for (const result of results) {
    entries.delete(result.id)
    entries.set(result.id, { result, at: now })
  }
  // The oldest one leaves first (the Map keeps the insertion order).
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

export function recallResult(id: string, now = Date.now()): ImageResult | null {
  const hit = entries.get(id.trim())
  if (!hit) return null
  if (now - hit.at > TTL_MS) {
    entries.delete(id.trim())
    return null
  }
  return hit.result
}

export function clearResultCache(): void {
  entries.clear()
}
