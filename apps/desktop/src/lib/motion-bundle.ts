import type { ChatMessage, MessagePart } from "@shared/chat"
import { motionBundleKey, type MotionBundle } from "@shared/media"

/**
 * What to do with the media of a message when they belong to a PIECE.
 *
 * While the agent builds a composition, every audio and every image it
 * generates becomes a loose player in the conversation — including the one that was later replaced.
 * The piece has a single card, and its players become LINES of that card. This
 * module is the arithmetic, pure and testable: given the message, the pieces of the conversation and
 * where each card lives, say which part becomes a card, which disappears and which remains
 * the usual player.
 *
 * Nothing is written into the message: the link comes from the FILE — the piece kept which
 * `aud_…`/`img_…` each of its files came from (see motion-files in main), and the part
 * carries the same id in the URL. That way an old conversation, recorded before this
 * existed, already shows up grouped.
 */

export interface MotionBundleIndexes {
  /** Media key (`aud_x.wav`, the path of a video) → owning piece. */
  byKey: Map<string, MotionBundle>
  /** motionId → id of the message where the card appears (the first one with media of it). */
  anchors: Record<string, string>
}

export const NO_BUNDLES: MotionBundleIndexes = { byKey: new Map(), anchors: {} }

export function indexMotionBundles(
  bundles: MotionBundle[],
  anchors: Record<string, string>,
): MotionBundleIndexes {
  const byKey = new Map<string, MotionBundle>()
  for (const bundle of bundles) {
    for (const key of bundle.keys) {
      // The first piece that claims the key owns it: the same file
      // copied into two pieces appears in the card of the one where it was born.
      if (!byKey.has(key)) byKey.set(key, bundle)
    }
  }
  return { byKey, anchors }
}

/** The piece this media belongs to — or `null` if it belongs to no piece. */
export function bundleOfPart(
  part: MessagePart,
  byKey: Map<string, MotionBundle>,
): MotionBundle | null {
  if (!byKey.size) return null
  if (part.type === "audio" || part.type === "image") {
    const key = motionBundleKey(part.src)
    return key ? byKey.get(key) ?? null : null
  }
  if (part.type === "video") {
    // Video has two identities: the registry URL and the path on disk (it is what
    // a render made in the project leaves in the part).
    for (const value of [part.src, part.path ?? ""]) {
      const key = value ? motionBundleKey(value) : null
      const hit = key ? byKey.get(key) : null
      if (hit) return hit
    }
  }
  return null
}

export interface MotionBundlePlan {
  /** Parts that draw nothing: they became the card or are already in it. */
  hidden: Set<string>
  /** Part that gives way to the card → piece. */
  cards: Map<string, MotionBundle>
}

export const NO_PLAN: MotionBundlePlan = { hidden: new Set(), cards: new Map() }

/**
 * One message, one piece, ONE card — the one of the message where the piece appeared for the
 * first time. Its media in the following messages disappear: the piece is the same,
 * and the card is already further up in the conversation, updated (it is what shows the
 * new file). Without this, re-recording a narration would leave a new card on every
 * attempt, which is exactly what the card came to end.
 */
export function planMotionBundles(
  parts: MessagePart[],
  indexes: MotionBundleIndexes,
  messageId: string,
): MotionBundlePlan {
  if (!indexes.byKey.size) return NO_PLAN
  const hidden = new Set<string>()
  const cards = new Map<string, MotionBundle>()
  // `cards` is indexed by PART, so the piece that already got the card needs its
  // own set — otherwise the first two media of the same piece become
  // two cards.
  const claimed = new Set<string>()
  for (const part of parts) {
    const bundle = bundleOfPart(part, indexes.byKey)
    if (!bundle) continue
    // Piece with no address yet (the list just arrived, the anchor calculation
    // comes in the next effect): NOTHING is collected. Hiding the media to
    // present it as a card one frame later would be a blink on screen.
    const anchor = indexes.anchors[bundle.motionId]
    if (!anchor) continue
    if (anchor === messageId && !claimed.has(bundle.motionId)) {
      claimed.add(bundle.motionId)
      cards.set(part.id, bundle)
      continue
    }
    hidden.add(part.id)
  }
  return hidden.size || cards.size ? { hidden, cards } : NO_PLAN
}

/**
 * Where the card of each piece lives: the FIRST message of the conversation that has media
 * of it. It is what keeps "one card per piece" even with media arriving in different
 * turns — the original card is the one that keeps the piece.
 */
export function motionBundleAnchors(
  messages: ChatMessage[],
  byKey: Map<string, MotionBundle>,
): Record<string, string> {
  const anchors: Record<string, string> = {}
  if (!byKey.size) return anchors
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      const bundle = bundleOfPart(part, byKey)
      if (bundle && !anchors[bundle.motionId]) anchors[bundle.motionId] = message.id
    }
  }
  return anchors
}
