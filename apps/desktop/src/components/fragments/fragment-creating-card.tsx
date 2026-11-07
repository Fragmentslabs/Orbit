import { useTranslation } from "react-i18next"
import { Sparkles, X } from "lucide-react"
import { Shimmer } from "@/src/components/ai/shimmer"
import { useSessionStatus } from "@/src/stores/session-store"
import { cn } from "@/lib/utils"
import { useFragmentsStore, type Creation } from "@/src/stores/fragments-store"
import { KIND_META } from "./kind-meta"


/** After this long without any activity, a creation that has not produced a fragment is over. */
const STALE_MS = 8000

/**
 * A fragment that is being made: it sits in the gallery like the others, with a shimmer,
 * so leaving the creating screen does not lose it. A click goes back to that screen. If the
 * agent stops without producing a fragment, the card says so and can be discarded.
 */
export function CreatingCard({ creation }: { creation: Creation }) {
  const { t } = useTranslation()
  const status = useSessionStatus(creation.sessionId)
  const viewCreation = useFragmentsStore((s) => s.viewCreation)
  const discard = useFragmentsStore((s) => s.discardCreation)
  const meta = KIND_META[creation.kind]
  const busy = status === "submitted" || status === "streaming"
  const ended = !busy && Date.now() - creation.startedAt > STALE_MS
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => viewCreation(creation.sessionId)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          viewCreation(creation.sessionId)
        }
      }}
      className="group/card relative flex animate-in cursor-pointer flex-col overflow-hidden rounded-xl border border-dashed border-primary/40 bg-card/60 text-left transition-colors fade-in-0 zoom-in-95 duration-500 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative flex aspect-[16/10] items-center justify-center overflow-hidden bg-muted/30">
        {!ended && (
          <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-primary/5 via-primary/15 to-primary/5" />
        )}
        <Sparkles className={cn("relative size-6 text-primary", !ended && "animate-pulse")} />
      </div>
      <div className="flex items-center gap-2.5 border-t border-border/60 px-3 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <meta.icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          {ended ? (
            <p className="truncate text-sm font-medium text-muted-foreground">{t("fragments.creationEnded")}</p>
          ) : (
            <Shimmer className="truncate text-sm font-medium">{t("fragments.phase1")}</Shimmer>
          )}
          <p className="text-[11px] text-muted-foreground">{t(meta.name)}</p>
        </div>
        {ended && (
          <button
            type="button"
            aria-label={t("fragments.discardCreation")}
            onClick={(e) => {
              e.stopPropagation()
              discard(creation.sessionId)
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
