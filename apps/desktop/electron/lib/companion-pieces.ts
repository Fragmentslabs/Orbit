import type { ChatMessage, MessagePart, ToolPart } from '@shared/chat'

import { pieceIdOf, pieceLookupOf, type PieceLookup } from './companion-media'
import { designIdForName, designIdForPath } from './design/design-store'
import { slidesIdForName, slidesIdForPath } from './slides/slides-store'
import { motionIdForName, motionIdForPath } from './video/motion-store'

/**
 * Gives the piece tool calls an id the phone can open.
 *
 * Real tool inputs address a piece by `name`/`path` and the result carries no id, so
 * `rewriteMediaPart` found nothing to attach and the phone fell back to a generic "1 action"
 * row. The desktop card does not need the id because the main resolves the reference against
 * the registry when it opens; this does the same lookup up front and writes the id into the
 * part's `input`, which `pieceIdOf` reads first. Kept apart from companion-media.ts, which
 * stays free of the stores (and of Electron) so it can be tested.
 */

async function resolve(lookup: PieceLookup, sessionId: string): Promise<string | null> {
  if (lookup.path) {
    const byPath =
      lookup.kind === 'motion'
        ? await motionIdForPath(lookup.path)
        : lookup.kind === 'design'
          ? await designIdForPath(lookup.path)
          : await slidesIdForPath(lookup.path)
    if (byPath) return byPath
  }
  if (!lookup.name) return null
  return lookup.kind === 'motion'
    ? motionIdForName(sessionId, lookup.name)
    : lookup.kind === 'design'
      ? designIdForName(sessionId, lookup.name)
      : slidesIdForName(sessionId, lookup.name)
}

function needsId(part: MessagePart): part is ToolPart {
  return part.type === 'tool' && part.state !== 'error' && !part.piece && !pieceIdOf(part) && pieceLookupOf(part) !== null
}

export function hasUnresolvedPiece(messages: readonly ChatMessage[]): boolean {
  return messages.some((m) => m.parts.some(needsId))
}

export async function resolvePart(part: MessagePart, sessionId: string): Promise<MessagePart> {
  if (!needsId(part)) return part
  const lookup = pieceLookupOf(part)
  if (!lookup) return part
  const id = await resolve(lookup, sessionId).catch(() => null)
  return id ? { ...part, input: { ...part.input, id } } : part
}

/** The same messages with the resolvable piece parts carrying their id; the input array when none did. */
export async function resolvePieceIds(messages: ChatMessage[], sessionId: string): Promise<ChatMessage[]> {
  if (!hasUnresolvedPiece(messages)) return messages
  const cache = new Map<string, Promise<MessagePart>>()
  const out = await Promise.all(
    messages.map(async (m) => {
      if (!m.parts.some(needsId)) return m
      const parts = await Promise.all(
        m.parts.map((p) => {
          if (!needsId(p)) return p
          const key = JSON.stringify([p.tool, p.input])
          let hit = cache.get(key)
          if (!hit) {
            hit = resolvePart(p, sessionId)
            cache.set(key, hit)
          }
          return hit.then((r) => (r === p || r.type !== 'tool' ? r : { ...p, input: r.input }))
        }),
      )
      return { ...m, parts }
    }),
  )
  return out
}
