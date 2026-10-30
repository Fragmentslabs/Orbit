import { Storage } from '~/lib/storage'

/**
 * Input draft per chat, persisted on the device — before it was only a Map in
 * memory: switching chats in the same app preserved it, but leaving the app (or the OS
 * killing the process) lost the typed text. The whole map lives under a single key
 * (SecureStore does not list keys) and the write is debounced: it cannot become a storage
 * write on every keystroke.
 */

const STORAGE_KEY = 'orbit_chat_drafts'
const FLUSH_MS = 400

const drafts = new Map<string, string>()
let hydrated = false

/** Loads the map from storage once per process. Called on boot (_layout) and
 *  guaranteed by the PromptInput before reading. */
export async function hydrateInputDrafts(): Promise<void> {
  if (hydrated) return
  hydrated = true
  try {
    const raw = await Storage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [sessionId, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value) drafts.set(sessionId, value)
      }
    }
  } catch {
    // Corrupted storage: starts clean.
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null

function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  writeTimer = setTimeout(() => {
    try {
      const obj: Record<string, string> = {}
      drafts.forEach((text, sessionId) => {
        if (text) obj[sessionId] = text
      })
      void Storage.setItem(STORAGE_KEY, JSON.stringify(obj))
    } catch {
      // Persistence is opportunistic — the draft remains valid in memory.
    }
  }, FLUSH_MS)
}

/** Empty text deletes the key: sending (setText('')) clears the draft. */
export function setInputDraft(sessionId: string, text: string) {
  if (text) drafts.set(sessionId, text)
  else drafts.delete(sessionId)
  flush()
}

export function getInputDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? ''
}

export function clearInputDraft(sessionId: string) {
  drafts.delete(sessionId)
  flush()
}
