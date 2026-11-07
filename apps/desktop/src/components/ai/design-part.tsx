import { useTranslation } from "react-i18next"
import { LayoutGrid } from "lucide-react"
import type { ToolPart } from "@shared/chat"
import { designApi } from "@/src/lib/ipc"
import { designRefOf } from "@/src/lib/design-part-ref"
import { PieceCard } from "@/src/components/ai/piece-card"

/**
 * Design canvas card (design_write/design_edit): the way back to
 * the tab — mirrors motion-part.tsx. Closing the panel tab cannot mean
 * losing sight of the canvas: this card comes from the tool part ITSELF, so it is already
 * in the history when the conversation is reopened.
 */
export function DesignPartView({ part, sessionId }: { part: ToolPart; sessionId?: string }) {
  const { t } = useTranslation()
  const ref = designRefOf(part)
  if (!ref || part.state === "error") return null
  const { id, path, name } = ref
  // The project canvas (code mode) resolves itself through the path; the conversation
  // canvas (chat mode) needs the session to be found.
  return (
    <PieceCard
      icon={LayoutGrid}
      label={ref.label}
      subtitle={`${path ?? t("design.composition")}${ref.boards ? ` · ${t("design.boardsCount", { count: ref.boards })}` : ""}`}
      openTitle={t("design.openTab")}
      goneText={t("design.gone")}
      canOpen={Boolean(id || path || (name && sessionId))}
      onOpen={() => designApi.open(id ? { id } : path ? { path } : { sessionId, name })}
    />
  )
}
