import type { FragmentKind } from "@shared/fragments"
import { FRAGMENT_KINDS } from "@shared/fragments"

/** A creation in progress: shown in the gallery as a card that is being made. */
export interface Creation {
  sessionId: string
  kind: FragmentKind
  startedAt: number
}

export const CREATIONS_STORAGE_KEY = "orbit-fragment-creations"

/** A creation whose chat never produced a fragment is not worth keeping for ever. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Reads the stored creations, dropping malformed or stale entries. */
export function parseCreations(raw: string | null, now: number = Date.now()): Creation[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: Creation[] = []
    for (const entry of parsed) {
      const { sessionId, kind, startedAt } = (entry ?? {}) as Partial<Creation>
      if (typeof sessionId !== "string" || !sessionId) continue
      if (!FRAGMENT_KINDS.includes(kind as FragmentKind)) continue
      if (typeof startedAt !== "number" || now - startedAt > MAX_AGE_MS) continue
      out.push({ sessionId, kind: kind as FragmentKind, startedAt })
    }
    return out
  } catch {
    return []
  }
}

export function loadCreations(): Creation[] {
  try {
    return parseCreations(localStorage.getItem(CREATIONS_STORAGE_KEY))
  } catch {
    return []
  }
}

export function saveCreations(creations: readonly Creation[]): void {
  try {
    localStorage.setItem(CREATIONS_STORAGE_KEY, JSON.stringify(creations))
  } catch {
    /* storage unavailable: the card just will not survive a restart */
  }
}
