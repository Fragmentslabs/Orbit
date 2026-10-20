import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { LayoutGrid, Loader2, X } from "lucide-react"
import type { ToolPart } from "@shared/chat"
import { cn } from "@/lib/utils"
import { designApi } from "@/src/lib/ipc"
import { designRefOf } from "@/src/lib/design-part-ref"

/**
 * Card do canvas de design (design_write/design_edit): o caminho de volta para
 * a aba — espelha motion-part.tsx. Fechar a aba do painel não pode significar
 * perder o canvas de vista: este card vem da PRÓPRIA tool part, então já está
 * no histórico quando a conversa é reaberta.
 */
export function DesignPartView({ part, sessionId }: { part: ToolPart; sessionId?: string }) {
  const { t } = useTranslation()
  const [opening, setOpening] = useState(false)
  const [gone, setGone] = useState(false)
  const ref = designRefOf(part)
  const path = ref?.path
  const name = ref?.name
  // Canvas do projeto (modo código) se resolve pelo caminho sozinho; canvas da
  // conversa (modo chat) precisa da sessão para ser encontrado.
  const canOpen = Boolean(path || (name && sessionId))

  const open = useCallback(() => {
    if (!canOpen || opening) return
    setOpening(true)
    setGone(false)
    designApi
      .open(path ? { path } : { sessionId, name })
      .then((ok) => setGone(!ok))
      .catch(() => setGone(true))
      .finally(() => setOpening(false))
  }, [canOpen, opening, path, sessionId, name])

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
          <p className="truncate text-sm font-medium text-foreground">{ref.label}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {path ?? t("design.composition")}
            {ref.boards ? ` · ${t("design.boardsCount", { count: ref.boards })}` : ""}
          </p>
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
