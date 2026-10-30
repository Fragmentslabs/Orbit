import type { MessagePart, ToolPart } from "@shared/chat"
import { designRefOf } from "./design-part-ref"
import { motionRefOf } from "./motion-part-ref"
import { slidesRefOf } from "./slides-part-ref"

/**
 * The piece tools (motion, design, slides) that leave a CARD in the conversation — the
 * same set in chat and in code, because the tools are the same in both
 * modes. Closing the panel tab cannot take the piece out of sight: the card is the
 * way back. Reading, copying an asset, looking at frames and deleting leave no card.
 */
export const MOTION_CARD_TOOLS = new Set(["motion_write", "motion_edit", "motion_preview"])
export const DESIGN_CARD_TOOLS = new Set(["design_write", "design_edit", "design_preview"])
export const SLIDES_CARD_TOOLS = new Set(["slides_write", "slides_edit", "slides_preview"])

export function isPieceCardTool(tool: string): boolean {
  return MOTION_CARD_TOOLS.has(tool) || DESIGN_CARD_TOOLS.has(tool) || SLIDES_CARD_TOOLS.has(tool)
}

/**
 * Identity of the piece behind a card, so the message shows ONE card per
 * piece: the design is written one screen per call, and six `design_write` in the same
 * answer gave six cards of the same canvas, filling the conversation with the same
 * button. What the calls have in common is the PIECE — the id (dsg_…) when the
 * history brings it, otherwise the path or the name the tool addressed.
 */
export function pieceCardKeyOf(part: MessagePart): string | null {
  if (part.type !== "tool" || !isPieceCardTool(part.tool)) return null
  const tool: ToolPart = part
  if (MOTION_CARD_TOOLS.has(tool.tool)) {
    const ref = motionRefOf(tool)
    const key = ref?.id ?? ref?.path ?? ref?.name
    return key ? `motion:${key}` : null
  }
  if (DESIGN_CARD_TOOLS.has(tool.tool)) {
    const ref = designRefOf(tool)
    const key = ref?.id ?? ref?.path ?? ref?.name
    return key ? `design:${key}` : null
  }
  const ref = slidesRefOf(tool)
  const key = ref?.id ?? ref?.path ?? ref?.name
  return key ? `slides:${key}` : null
}

/**
 * Keeps a piece's card in the message — ONE per piece. `design_write` runs one
 * screen per call, and each one stacked another card of the same canvas: the conversation
 * ended up with four buttons to the same place. The card of the FIRST place stays, and
 * starts showing the NEW call, which is the one that knows the piece's final state
 * ("4 screens" instead of "1 screen"); the following ones add nothing.
 *
 * Returns the segment when it is new — whoever calls decides where it goes —, and
 * `null` when the piece already had a card there.
 */
export function landPieceCard<S extends { part: MessagePart }>(
  cards: Map<string, S>,
  part: MessagePart,
  create: (part: MessagePart) => S,
): S | null {
  const key = pieceCardKeyOf(part)
  if (!key) return create(part)
  const existing = cards.get(key)
  if (existing) {
    existing.part = part
    return null
  }
  const segment = create(part)
  cards.set(key, segment)
  return segment
}
