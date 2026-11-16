/**
 * Pure logic of the in-conversation search: matching, highlight ranges and
 * navigation. No React / React Native imports so it is trivially testable.
 */
import type { ChatMessage } from '@orbit/shared'
import { visibleMessageText } from '~/lib/message-utils'

const DIACRITICS = /[̀-ͯ]/g

/**
 * Folds one string to lowercase without accents while keeping a map from every
 * folded UTF-16 unit back to the index of the source character it came from. The
 * map is what lets a match found in the folded text be painted on the ORIGINAL
 * text (folding can change the length, e.g. "İ" or decomposed accents).
 */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = ''
  const map: number[] = []
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) as number
    const ch = String.fromCodePoint(cp)
    const f = ch.normalize('NFD').replace(DIACRITICS, '').toLowerCase()
    for (let k = 0; k < f.length; k++) map.push(i)
    folded += f
    i += ch.length
  }
  map.push(text.length)
  return { folded, map }
}

/** Case- and accent-insensitive form used for both the needle and the haystacks. */
export function foldForSearch(text: string): string {
  return foldWithMap(text).folded
}

export interface HighlightPiece {
  text: string
  match: boolean
}

/** Splits `text` into alternating plain / matched pieces for every occurrence of `query`. */
export function splitByQuery(text: string, query: string): HighlightPiece[] {
  const needle = foldForSearch(query.trim())
  if (!needle || !text) return [{ text, match: false }]
  const { folded, map } = foldWithMap(text)
  const pieces: HighlightPiece[] = []
  let cursor = 0 // index in the source text
  let from = 0
  for (;;) {
    const at = folded.indexOf(needle, from)
    if (at === -1) break
    const start = map[at]
    const end = map[at + needle.length] ?? text.length
    if (start >= cursor && end > start) {
      if (start > cursor) pieces.push({ text: text.slice(cursor, start), match: false })
      pieces.push({ text: text.slice(start, end), match: true })
      cursor = end
    }
    from = at + needle.length
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), match: false })
  return pieces.length > 0 ? pieces : [{ text, match: false }]
}

// Folded text is computed once per message object: a new object (edit, streaming
// delta) gets a new entry, an untouched message is never folded twice.
const foldedCache = new WeakMap<ChatMessage, string>()

/** What the search looks at: the text shown in the bubble, folded. */
export function searchableText(message: ChatMessage): string {
  let cached = foldedCache.get(message)
  if (cached === undefined) {
    cached = foldForSearch(visibleMessageText(message))
    foldedCache.set(message, cached)
  }
  return cached
}

/** Ids of the messages containing `query`, in conversation order. */
export function findMatchIds(messages: ChatMessage[], query: string): string[] {
  const needle = foldForSearch(query.trim()).replace(/\s+/g, ' ')
  if (!needle) return []
  const out: string[] = []
  for (const m of messages) {
    if (m.summary) continue
    if (searchableText(m).replace(/\s+/g, ' ').includes(needle)) out.push(m.id)
  }
  return out
}

/** Wrapping step through `total` results; `delta` is +1 / -1. */
export function stepIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return 0
  return (((current + delta) % total) + total) % total
}

/**
 * Keeps the active index pointing at the same message when the result list
 * changes (new streamed message, refined query); falls back to the first result.
 */
export function reconcileIndex(prevId: string | undefined, ids: string[]): number {
  if (!prevId) return 0
  const i = ids.indexOf(prevId)
  return i === -1 ? 0 : i
}
