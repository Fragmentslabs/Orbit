import type { ToolPart } from "@shared/chat"
import { DESIGN_CARD_TOOLS, FRAGMENT_CARD_TOOLS, MOTION_CARD_TOOLS, SLIDES_CARD_TOOLS } from "@/src/lib/piece-tools"
import { DesignPartView } from "@/src/components/ai/design-part"
import { FragmentPartView } from "@/src/components/ai/fragment-part"
import { MotionPartView } from "@/src/components/ai/motion-part"
import { SlidesPartView } from "@/src/components/ai/slides-part"

/**
 * The card of a piece, whichever kind made it. The one place that maps a tool to its card,
 * shared by the chat and the code message — a new kind adds a line here (and its tool set in
 * piece-tools.ts), not one in each message component.
 */
export function PieceCardView({ part, sessionId }: { part: ToolPart; sessionId?: string }) {
  if (MOTION_CARD_TOOLS.has(part.tool)) return <MotionPartView part={part} sessionId={sessionId} />
  if (DESIGN_CARD_TOOLS.has(part.tool)) return <DesignPartView part={part} sessionId={sessionId} />
  if (SLIDES_CARD_TOOLS.has(part.tool)) return <SlidesPartView part={part} sessionId={sessionId} />
  if (FRAGMENT_CARD_TOOLS.has(part.tool)) return <FragmentPartView part={part} sessionId={sessionId} />
  return null
}
