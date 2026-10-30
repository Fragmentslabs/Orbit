import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { LayoutGrid, Loader2, X } from "lucide-react"
import type { ToolPart } from "@shared/chat"
import { cn } from "@/lib/utils"
import { designApi } from "@/src/lib/ipc"
import { designRefOf } from "@/src/lib/design-part-ref"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Design canvas card (design_write/design_edit): the way back to
 * the tab — mirrors motion-part.tsx. Closing the panel tab cannot mean
 * losing sight of the canvas: this card comes from the tool part ITSELF, so it is already
 * in the history when the conversation is reopened.
 */
export function DesignPartView({ part, sessionId }: { part: ToolPart; sessionId?: string }) {
  const { t } = useTranslation()
  const [opening, setOpening] = useState(false)
  const [gone, setGone] = useState(false)
  const ref = designRefOf(part)
  const id = ref?.id
  const path = ref?.path
  const name = ref?.name
  // The project canvas (code mode) resolves itself through the path; the conversation
  // canvas (chat mode) needs the session to be found.
  const canOpen = Boolean(id || path || (name && sessionId))

  const open = useCallback(() => {
    if (!canOpen || opening) return
    setOpening(true)
    setGone(false)
    designApi
      .open(id ? { id } : path ? { path } : { sessionId, name })
      .then((ok) => setGone(!ok))
      .catch(() => setGone(true))
      .finally(() => setOpening(false))
  }, [canOpen, opening, id, path, sessionId, name])

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
        title={canOpen ? t("design.openTab") : undefined}
        className={cn(
          "flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5 transition-colors",
          canOpen && "cursor-pointer hover:bg-accent/50",
        )}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
          <LayoutGrid className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <Truncate text={ref.label}>
            <p className="truncate text-sm font-medium text-foreground">{ref.label}</p>
          </Truncate>
          
            <Truncate>
              <p className="truncate text-[11px] text-muted-foreground">
              {path ?? t("design.composition")}
              {ref.boards ? ` · ${t("design.boardsCount", { count: ref.boards })}` : ""}
            </p>
            </Truncate>
        </div>
        {opening && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      {gone && (
        <div className="mt-1 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <p className="min-w-0 flex-1">{t("design.gone")}</p>
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
