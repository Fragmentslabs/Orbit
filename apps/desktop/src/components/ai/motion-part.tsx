import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { Clapperboard, Loader2, X } from "lucide-react"
import type { ToolPart } from "@shared/chat"
import { cn } from "@/lib/utils"
import { motionApi } from "@/src/lib/ipc"
import { motionRefOf } from "@/src/lib/motion-part-ref"

/**
 * Card da peça de motion (motion_preview, motion_write, motion_edit): o caminho
 * de volta para a composição.
 *
 * A aba do painel vive em MEMÓRIA — fechá-la era perder a peça de vista, mesmo
 * com ela inteira no disco, porque nada a listava na conversa. Este card é o que
 * fica: é desenhado da PRÓPRIA tool part (como o card de skill), então já está
 * no histórico quando a conversa é reaberta, sem depender de nenhum registro
 * posterior.
 *
 * Os dois modos endereçam a peça de jeitos diferentes e o card cobre os dois —
 * o caminho da pasta do projeto (código) e o nome da composição da conversa
 * (chat). Ver `motionRefOf`.
 *
 * O id da composição não vem no card: quem traduz referência em peça é o main,
 * que é o dono do registro (`motion.json`). O renderer não conhece pasta de
 * projeto — e no chat não há pasta nenhuma para conhecer.
 */

export function MotionPartView({ part, sessionId }: { part: ToolPart; sessionId?: string }) {
  const { t } = useTranslation()
  const [opening, setOpening] = useState(false)
  const [gone, setGone] = useState(false)
  const ref = motionRefOf(part)
  const path = ref?.path
  const name = ref?.name
  // Composição da conversa precisa da sessão para ser encontrada; a do projeto
  // se resolve pelo caminho sozinha.
  const canOpen = Boolean(path || (name && sessionId))

  const open = useCallback(() => {
    if (!canOpen || opening) return
    setOpening(true)
    setGone(false)
    motionApi
      .open(path ? { path } : { sessionId, name })
      .then((ok) => setGone(!ok))
      .catch(() => setGone(true))
      .finally(() => setOpening(false))
  }, [canOpen, opening, path, name, sessionId])

  // Sem referência não há o que reabrir — e uma peça que falhou já é dita em
  // texto pelo agente, que viu o erro da tool.
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
          <p className="truncate text-sm font-medium text-foreground">{ref.label}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {path ?? t("motion.composition")}
            {ref.format && ` · ${ref.format}`}
          </p>
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
