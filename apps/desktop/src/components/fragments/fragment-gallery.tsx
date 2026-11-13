import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Download, Layers, Orbit, Plug, PlusIcon, Upload, UserRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { FragmentManifest } from "@shared/fragments"
import { useWorkspace } from "@/lib/workspace-context"
import { FilterChips, FilterRail, type FilterOption } from "@/src/components/filter-rail"
import { ListToolbar } from "@/src/components/list-toolbar"
import { useStacked } from "@/src/hooks/use-stacked"
import { fragmentSource, type FragmentSource } from "@/src/lib/fragment-origins"
import { startCreation } from "@/src/lib/start-creation"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { FragmentCard } from "./fragment-card"
import { FragmentImportDialog, FragmentImportProblemNote } from "./share/fragment-import-dialog"
import { useFragmentImport } from "./share/use-fragment-import"

/**
 * The page's first level: a grid of cards, each with a LIVE thumbnail of the fragment.
 * Fragments the person pinned to the sidebar come first (they are the ones used every
 * day); the rest follow. Searchable, filterable by origin, with the "new" action — which
 * opens a normal chat with the fragment agent, the one place a fragment is created.
 *
 * The origin filter is the right-hand rail: every source with its count, so the library
 * says WHERE each fragment came from without opening one.
 */
export function FragmentGallery() {
  const { t } = useTranslation()
  const { mode, setView } = useWorkspace()
  const items = useFragmentsStore((s) => s.items)
  const origins = useFragmentsStore((s) => s.origins)
  const loaded = useFragmentsStore((s) => s.loaded)
  const open = useFragmentsStore((s) => s.open)
  const [query, setQuery] = useState("")
  const [source, setSource] = useState<FragmentSource>("all")
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const stacked = useStacked(root, 680)
  const importer = useFragmentImport()
  const [dragging, setDragging] = useState(false)

  const counts = useMemo(() => {
    const totals: Record<FragmentSource, number> = { all: items.length, native: 0, integration: 0, imported: 0, local: 0 }
    for (const fragment of items) totals[fragmentSource(fragment, origins[fragment.id])] += 1
    return totals
  }, [items, origins])

  const sourceOptions = useMemo<FilterOption<FragmentSource>[]>(
    () => [
      { value: "all", label: t("fragments.origins.all"), icon: Layers, count: counts.all },
      { value: "native", label: t("fragments.origins.native"), icon: Orbit, count: counts.native },
      { value: "integration", label: t("fragments.origins.integration"), icon: Plug, count: counts.integration },
      { value: "imported", label: t("fragments.origins.imported"), icon: Download, count: counts.imported },
      { value: "local", label: t("fragments.origins.local"), icon: UserRound, count: counts.local },
    ],
    [counts, t],
  )

  const hint =
    source === "native"
      ? t("fragments.origins.nativeHint")
      : source === "integration"
        ? t("fragments.origins.integrationHint")
        : source === "imported"
          ? t("fragments.origins.importedHint")
          : source === "local"
            ? t("fragments.origins.localHint")
            : t("fragments.origins.allHint")

  const { pinned, others } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const visible = items.filter(
      (fragment) =>
        (!q || fragment.name.toLowerCase().includes(q)) &&
        (source === "all" || fragmentSource(fragment, origins[fragment.id]) === source),
    )
    return {
      pinned: visible.filter((f) => f.pinned.sidebar || f.pinned.panel),
      others: visible.filter((f) => !f.pinned.sidebar && !f.pinned.panel),
    }
  }, [items, origins, query, source])

  const nothingMatches = pinned.length + others.length === 0

  // Creating happens in a chat: a new conversation with the fragment agent, the ready-made
  // sentence in the composer and the fields for the person to fill.
  const createFragment = () => {
    setView("chat")
    void startCreation(mode, "fragment", t("panel.hub.fragment.prompt"))
  }

  return (
    <div
      ref={setRoot}
      className="relative flex min-h-0 flex-1"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const file = e.dataTransfer.files[0]
        if (file) void importer.start(file)
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col px-4">
        <ListToolbar
          className="pt-3"
          query={query}
          onQueryChange={setQuery}
          placeholder={t("fragments.search")}
          actionLabel={t("fragments.new")}
          actionIcon={PlusIcon}
          onAction={createFragment}
        >
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1 px-3 text-xs"
            onClick={importer.pickFile}
            disabled={importer.busy}
          >
            <Upload className="size-3.5" />
            {t("fragments.share.importButton")}
          </Button>
        </ListToolbar>
        <FragmentImportProblemNote problem={importer.problem} onDismiss={importer.dismissProblem} />
        <FragmentImportDialog preview={importer.preview} busy={importer.busy} onConfirm={importer.confirm} onCancel={importer.cancel} />

        {stacked && <FilterChips className="shrink-0" options={sourceOptions} value={source} onChange={setSource} />}

        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-background/80 text-sm font-medium">
            {t("fragments.share.drop")}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loaded && items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm font-medium">{t("fragments.emptyTitle")}</p>
              <p className="max-w-sm text-xs text-muted-foreground">{t("fragments.emptyHint")}</p>
              <Button size="sm" className="h-8 gap-1.5 px-3 text-xs" onClick={createFragment}>
                <PlusIcon className="size-3.5" />
                {t("fragments.new")}
              </Button>
            </div>
          ) : nothingMatches ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {source === "native" ? t("fragments.origins.nativeEmpty") : t("fragments.noMatch")}
            </p>
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

      {!stacked && (
        <aside className="flex w-[248px] shrink-0 flex-col overflow-y-auto border-l border-border p-3">
          <FilterRail
            title={t("fragments.origins.title")}
            count={counts.all}
            countLabel={t("fragments.origins.count", { count: counts.all })}
            options={sourceOptions}
            value={source}
            onChange={setSource}
            hint={hint}
          />
        </aside>
      )}
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
