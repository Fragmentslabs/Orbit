import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { Clapperboard, Loader2, X } from "lucide-react"
import type { ToolPart } from "@shared/chat"
import { cn } from "@/lib/utils"
import { motionApi } from "@/src/lib/ipc"
import { motionRefOf } from "@/src/lib/motion-part-ref"
import { Truncate } from "@/components/ui/truncated-text"

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
  const [opening, setOpening] = useState(false)
  const [gone, setGone] = useState(false)
  const ref = motionRefOf(part)
  const id = ref?.id
  const path = ref?.path
  const name = ref?.name
  // The conversation composition needs the session to be found; the project
  // one resolves itself through the path.
  const canOpen = Boolean(id || path || (name && sessionId))

  const open = useCallback(() => {
    if (!canOpen || opening) return
    setOpening(true)
    setGone(false)
    motionApi
      .open(id ? { id } : path ? { path } : { sessionId, name })
      .then((ok) => setGone(!ok))
      .catch(() => setGone(true))
      .finally(() => setOpening(false))
  }, [canOpen, opening, id, path, name, sessionId])

  // Without a reference there is nothing to reopen — and a piece that failed is already said in
  // text by the agent, which saw the tool's error.
  if (!ref || part.state === "error") return null

  return (
    <div className="not-prose my-2 w-full max-w-md">
      <div
        role={canOpen ? "button" : undefined}
        tabIndex={canOpen ? 0 : undefined}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            open()
          }
        }}
        title={canOpen ? t("motion.openTab") : undefined}
        className={cn(
          "flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5 transition-colors",
          canOpen && "cursor-pointer hover:bg-accent/50",
        )}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
          <Clapperboard className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <Truncate text={ref.label}>
            <p className="truncate text-sm font-medium text-foreground">{ref.label}</p>
          </Truncate>
          
            <Truncate>
              <p className="truncate text-[11px] text-muted-foreground">
              {path ?? t("motion.composition")}
              {ref.format && ` · ${ref.format}`}
            </p>
            </Truncate>
        </div>
        {opening && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      {gone && (
        <div className="mt-1 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <p className="min-w-0 flex-1">{t("motion.gone")}</p>
          <button
            type="button"
            onClick={() => setGone(false)}
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-destructive/20"
            aria-label={t("common.close")}
          >
            <X className="size-3" />
          </button>
        </div>
      )}
    </div>
  )
}
