/**
 * Text search across sessions (title + text of the messages) for the UI and the
 * companion. It reads the in-memory session index — there is no scan here and no
 * ceiling on how many sessions are covered.
 */
import type { SearchHit } from '@shared/chat'
import { excerpt, sessionIndex } from './session-index'

const MAX_HITS_PER_SESSION = 5
const MAX_RESULTS = 100
const SNIPPET_WIDTH = 120

export async function searchSessions(query: string): Promise<SearchHit[]> {
  if (!query?.trim()) return []
  const { matches, terms } = await sessionIndex().search({ query, includeArchived: true })

  // Chats in the order of their best match; within a chat, best match first.
  const perChat = new Map<string, SearchHit[]>()
  for (const { chat, passage } of matches) {
    const hits = perChat.get(chat.id) ?? []
    if (hits.length >= MAX_HITS_PER_SESSION) continue
    hits.push({
      sessionId: chat.id,
      sessionTitle: chat.title,
      mode: chat.mode,
      updatedAt: chat.updatedAt,
      snippet: passage.role === 'title' ? chat.title : excerpt(passage.text, terms, SNIPPET_WIDTH),
    })
    perChat.set(chat.id, hits)
  }
  return [...perChat.values()].flat().slice(0, MAX_RESULTS)
}
