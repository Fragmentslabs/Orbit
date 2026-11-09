import { randomUUID } from 'node:crypto'

/**
 * Things that were read from a shared file and are waiting for the person's confirmation.
 *
 * The verified content stays in the main process: the renderer gets a token, shows the
 * consent card, and sends the token back. It can therefore only confirm exactly what it was
 * shown, never swap in something else between the card and the click. Entries expire, and a
 * confirmation spends the token.
 */
export interface PendingStore<T> {
  put(value: T): string
  /** The value, or null when the token is unknown or expired. The token is spent. */
  take(token: string): T | null
  drop(token: string): void
}

export function createPendingStore<T>(options: { ttlMs?: number; max?: number; now?: () => number } = {}): PendingStore<T> {
  const ttl = options.ttlMs ?? 10 * 60_000
  const max = options.max ?? 8
  const now = options.now ?? Date.now
  const items = new Map<string, { value: T; expires: number }>()

  const sweep = () => {
    for (const [token, item] of items) if (item.expires <= now()) items.delete(token)
  }

  return {
    put(value) {
      sweep()
      // Oldest first: a person picking files over and over cannot grow this without bound.
      while (items.size >= max) items.delete(items.keys().next().value as string)
      const token = randomUUID()
      items.set(token, { value, expires: now() + ttl })
      return token
    },
    take(token) {
      sweep()
      const item = items.get(token)
      if (!item) return null
      items.delete(token)
      return item.value
    },
    drop(token) {
      items.delete(token)
    },
  }
}
