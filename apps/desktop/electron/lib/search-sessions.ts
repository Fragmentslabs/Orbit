/**
 * Busca textual entre sessões (título + parts text das mensagens).
 * Scan linear on-demand — mesmos caps do IPC search:sessions.
 */
import type { ChatMessage, SearchHit, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { listKeys, readJson } from './storage'

const MAX_SESSIONS = 40
const MAX_HITS_PER_SESSION = 5
const MAX_RESULTS = 50
const SNIPPET_PAD = 40

export async function searchSessions(query: string): Promise<SearchHit[]> {
  if (!query?.trim()) return []
  const q = query.toLowerCase().trim()

  const keys = await listKeys(StorageKeys.sessionPrefix)
  const all = (
    await Promise.all(keys.map((k) => readJson<SessionInfo>(k)))
  ).filter((s): s is SessionInfo => s !== null)
  all.sort((a, b) => b.updatedAt - a.updatedAt)

  const results: SearchHit[] = []

  for (const info of all.slice(0, MAX_SESSIONS)) {
    const hits: string[] = []

    if (info.title.toLowerCase().includes(q)) {
      hits.push(info.title)
    }

    if (hits.length < MAX_HITS_PER_SESSION) {
      const msgs = (await readJson<ChatMessage[]>(StorageKeys.messages(info.id))) ?? []
      for (const msg of msgs) {
        for (const part of msg.parts) {
          if (part.type === 'text' && part.text.toLowerCase().includes(q)) {
            const idx = part.text.toLowerCase().indexOf(q)
            const start = Math.max(0, idx - SNIPPET_PAD)
            const end = Math.min(part.text.length, idx + q.length + SNIPPET_PAD)
            let snippet = part.text.slice(start, end)
            if (start > 0) snippet = '…' + snippet
            if (end < part.text.length) snippet += '…'
            hits.push(snippet)
            if (hits.length >= MAX_HITS_PER_SESSION) break
          }
        }
        if (hits.length >= MAX_HITS_PER_SESSION) break
      }
    }

    for (const snippet of hits.slice(0, MAX_HITS_PER_SESSION)) {
      results.push({
        sessionId: info.id,
        sessionTitle: info.title,
        mode: info.mode,
        updatedAt: info.updatedAt,
        snippet,
      })
    }

    if (results.length >= MAX_RESULTS) break
  }

  return results
}
