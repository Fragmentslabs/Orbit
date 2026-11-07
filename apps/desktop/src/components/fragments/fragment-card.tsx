import { useTranslation } from "react-i18next"
import { Pin, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import type { FragmentManifest } from "@shared/fragments"
import { FragmentIcon } from "./fragment-icon"
import { FragmentPreview } from "./fragment-preview"
import { FragmentActionsMenu } from "./fragment-actions-menu"
import { KIND_META } from "./kind-meta"


export function FragmentCard({ fragment, onOpen }: { fragment: FragmentManifest; onOpen: () => void }) {
  const { t, i18n } = useTranslation()
  const meta = KIND_META[fragment.kind]
      return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className="group/card relative flex animate-in cursor-pointer flex-col overflow-hidden rounded-xl border border-border/60 bg-card text-left transition-colors fade-in-0 duration-300 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <FragmentPreview manifest={fragment} />
      {/* Actions: shown on hover, and kept while the menu is open. Clicks here never open the card. */}
      <div onClick={(e) => e.stopPropagation()} className="absolute right-2 top-2">
        <FragmentActionsMenu
          fragment={fragment}
          triggerClassName={(open) =>
            cn(
              "flex size-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground backdrop-blur transition-opacity hover:text-foreground focus-visible:opacity-100",
              open ? "opacity-100" : "opacity-0 group-hover/card:opacity-100",
            )
          }
        />
      </div>
      <div className="flex items-center gap-2.5 border-t border-border/60 px-3 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FragmentIcon name={fragment.icon} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{fragment.name}</p>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{t(meta.name)}</span>
            {fragment.requests.includes("ai") && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 text-primary">
                <Sparkles className="size-2.5" />
                {t("fragments.usesAi")}
              </span>
            )}
          </div>
        </div>
        {fragment.pinned.sidebar && <Pin className="size-3 shrink-0 text-primary" aria-label={t("fragments.unpinSidebar")} />}
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {new Date(fragment.updatedAt).toLocaleDateString(i18n.language, { day: "2-digit", month: "2-digit" })}
        </span>
      </div>
    </div>
  )
}

