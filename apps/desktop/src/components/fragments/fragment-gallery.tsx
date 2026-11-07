import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Pin, PinOff, PlusIcon, Sparkles } from "lucide-react"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Hint } from "@/components/ui/hint"
import { cn } from "@/lib/utils"
import type { FragmentKind, FragmentManifest } from "@shared/fragments"
import { ListToolbar } from "@/src/components/list-toolbar"
import { fragmentApi } from "@/src/lib/ipc"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { FragmentIcon } from "./fragment-icon"
import { FragmentPreview } from "./fragment-preview"
import { KIND_META } from "./kind-meta"

type Filter = "all" | FragmentKind

/**
 * The page's first level: a grid of cards, each with a LIVE thumbnail of the fragment.
 * Fragments the person pinned to the sidebar come first (they are the ones used every
 * day); the rest follow. Searchable, filterable by kind, with the "new" action.
 */
export function FragmentGallery() {
  const { t } = useTranslation()
  const items = useFragmentsStore((s) => s.items)
  const loaded = useFragmentsStore((s) => s.loaded)
  const open = useFragmentsStore((s) => s.open)
  const startComposing = useFragmentsStore((s) => s.startComposing)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")

  const { pinned, others } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const visible = items.filter((f) => (filter === "all" || f.kind === filter) && (!q || f.name.toLowerCase().includes(q)))
    return {
      pinned: visible.filter((f) => f.pinned.sidebar || f.pinned.panel),
      others: visible.filter((f) => !f.pinned.sidebar && !f.pinned.panel),
    }
  }, [items, query, filter])

  const nothingMatches = pinned.length + others.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ListToolbar
        query={query}
        onQueryChange={setQuery}
        placeholder={t("fragments.search")}
        actionLabel={t("fragments.new")}
        actionIcon={PlusIcon}
        onAction={startComposing}
      >
        <SegmentedControl<Filter>
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: t("fragments.filterAll") },
            { value: "screen", label: t("fragments.kind.screen.name") },
            { value: "panel", label: t("fragments.kind.panel.name") },
            { value: "widget", label: t("fragments.kind.widget.name") },
          ]}
        />
      </ListToolbar>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loaded && items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium">{t("fragments.emptyTitle")}</p>
            <p className="max-w-sm text-xs text-muted-foreground">{t("fragments.emptyHint")}</p>
          </div>
        ) : nothingMatches ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t("fragments.noMatch")}</p>
        ) : (
          <div className="flex flex-col gap-5 pb-4">
            {pinned.length > 0 && <Section title={t("fragments.sectionPinned")} items={pinned} onOpen={open} />}
            {others.length > 0 && (
              <Section title={pinned.length > 0 ? t("fragments.sectionOthers") : undefined} items={others} onOpen={open} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, items, onOpen }: { title?: string; items: FragmentManifest[]; onOpen: (id: string) => void }) {
  return (
    <section>
      {title && <p className="mb-2 text-[11px] font-medium text-muted-foreground">{title}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((fragment) => (
          <FragmentCard key={fragment.id} fragment={fragment} onOpen={() => onOpen(fragment.id)} />
        ))}
      </div>
    </section>
  )
}

function FragmentCard({ fragment, onOpen }: { fragment: FragmentManifest; onOpen: () => void }) {
  const { t, i18n } = useTranslation()
  const meta = KIND_META[fragment.kind]
  const pinned = fragment.pinned.sidebar
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className="group/card relative flex cursor-pointer flex-col overflow-hidden rounded-xl border border-border/60 bg-card text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <FragmentPreview manifest={fragment} />
      <Hint label={t(pinned ? "fragments.unpinSidebar" : "fragments.pinSidebar")}>
        <button
          type="button"
          aria-label={t(pinned ? "fragments.unpinSidebar" : "fragments.pinSidebar")}
          onClick={(e) => {
            e.stopPropagation()
            void fragmentApi.update(fragment.id, { pinned: { sidebar: !pinned } })
          }}
          className={cn(
            "absolute right-2 top-2 flex size-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground backdrop-blur transition-opacity hover:text-foreground",
            pinned ? "text-primary opacity-100" : "opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100",
          )}
        >
          {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </button>
      </Hint>
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
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {new Date(fragment.updatedAt).toLocaleDateString(i18n.language, { day: "2-digit", month: "2-digit" })}
        </span>
      </div>
    </div>
  )
}
