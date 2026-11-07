import { useTranslation } from "react-i18next"
import { Clapperboard } from "lucide-react"
import type { ToolPart } from "@shared/chat"
import { motionApi } from "@/src/lib/ipc"
import { motionRefOf } from "@/src/lib/motion-part-ref"
import { PieceCard } from "@/src/components/ai/piece-card"

/**
 * Card of the motion piece (motion_preview, motion_write, motion_edit): the way
 * back to the composition.
 *
 * The panel tab lives in MEMORY — closing it meant losing sight of the piece, even
 * with it entirely on disk, because nothing listed it in the conversation. This card is what
 * remains: it is drawn from the tool part ITSELF (like the skill card), so it is already
 * in the history when the conversation is reopened, without depending on any later
 * record.
 *
 * The two modes address the piece in different ways and the card covers both —
 * the project folder path (code) and the name of the conversation composition
 * (chat). See `motionRefOf`.
 *
 * The composition id does not come in the card: the main process is what translates a reference into a piece,
 * and it owns the registry (`motion.json`). The renderer does not know the project
 * folder — and in chat there is no folder at all to know.
 */
export function MotionPartView({ part, sessionId }: { part: ToolPart; sessionId?: string }) {
  const { t } = useTranslation()
  const ref = motionRefOf(part)
  // Without a reference there is nothing to reopen — and a piece that failed is already said in
  // text by the agent, which saw the tool's error.
  if (!ref || part.state === "error") return null
  const { id, path, name } = ref
  // The conversation composition needs the session to be found; the project one resolves
  // itself through the path.
  return (
    <PieceCard
      icon={Clapperboard}
      label={ref.label}
      subtitle={`${path ?? t("motion.composition")}${ref.format ? ` · ${ref.format}` : ""}`}
      openTitle={t("motion.openTab")}
      goneText={t("motion.gone")}
      canOpen={Boolean(id || path || (name && sessionId))}
      onOpen={() => motionApi.open(id ? { id } : path ? { path } : { sessionId, name })}
    />
  )
}
