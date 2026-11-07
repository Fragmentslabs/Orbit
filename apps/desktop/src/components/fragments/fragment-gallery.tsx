import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { PlusIcon } from "lucide-react"
import { SegmentedControl } from "@/components/ui/segmented-control"
import type { FragmentKind, FragmentManifest } from "@shared/fragments"
import { ListToolbar } from "@/src/components/list-toolbar"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { FragmentCard } from "./fragment-card"
import { CreatingCard } from "./fragment-creating-card"

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
  const creations = useFragmentsStore((s) => s.creations)
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
        {loaded && items.length === 0 && creations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium">{t("fragments.emptyTitle")}</p>
            <p className="max-w-sm text-xs text-muted-foreground">{t("fragments.emptyHint")}</p>
          </div>
        ) : nothingMatches && creations.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t("fragments.noMatch")}</p>
        ) : (
          <div className="flex flex-col gap-5 pb-4">
            {creations.length > 0 && (
              <section>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {creations.map((creation) => (
                    <CreatingCard key={creation.sessionId} creation={creation} />
                  ))}
                </div>
              </section>
            )}
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
