import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, List, Network, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace-context"
import type { MemoryRoutineMode } from "@shared/app-settings"
import type { Memory, MemoryKind, ProjectCategory } from "@shared/memory"
import { searchMemories, visibleIn } from "@shared/memory"
import { matchesProjectFilter } from "@shared/memory-layout"
import { useAppSettings } from "@/src/stores/app-settings"
import { useMemoryStore } from "@/src/stores/memory-store"
import { MemoryCard } from "./memory-card"
import { MemoryDetailPanel } from "./memory-detail-panel"
import { MemoryGraph } from "./memory-graph"
import { CATEGORY_LABEL, lastActivity } from "./meta"

/** Stable reference for memories without neighbors — it avoids breaking the memo. */
const EMPTY_RELATED: Memory[] = []

/**
 * Memories view: list of cards or tree of connections (SVG with zoom/pan),
 * with an automatic filter by the workspace mode — chat shows
 * core+seasonal+general, code shows project+general (project selector).
 *
 * Choosing a project in the selector restricts the view to what belongs to it: the
 * project memories plus the general ones created there. General ones from other projects
 * stay out — to see them, set the selector back to "all projects".
 */

const ALL_PROJECTS = "__all__"
const ALL_CATEGORIES = "__all__"

/** i18n key suffix of each memory-routine option. */
function routineKey(mode: MemoryRoutineMode): string {
  return mode === "daily+weekly" ? "dailyWeekly" : mode
}
/** Cards rendered at a time — the rest enters as one scrolls. */
const PAGE_SIZE = 24

/**
 * Placeholder of the initial loading. Without it the screen blinks the empty state
 * ("no memories") before the index arrives from the main process, which reads as if there were
 * nothing saved.
 */
function MemoriesSkeleton({ graph }: { graph: boolean }) {
  if (graph) {
    return (
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border">
        {/* Sparse nodes, in the spirit of the graph that is going to appear */}
        {[
          { top: "44%", left: "48%", size: 44 },
          { top: "26%", left: "30%", size: 26 },
          { top: "30%", left: "68%", size: 26 },
          { top: "62%", left: "26%", size: 22 },
          { top: "68%", left: "62%", size: 22 },
          { top: "16%", left: "52%", size: 18 },
          { top: "78%", left: "44%", size: 18 },
        ].map((node, i) => (
          <Skeleton
            key={i}
            className="absolute rounded-full"
            style={{ top: node.top, left: node.left, width: node.size, height: node.size }}
          />
        ))}
      </div>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-hidden pr-1">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <div className="flex gap-1.5">
              <Skeleton className="h-4 w-14 rounded-full" />
              <Skeleton className="h-4 w-20 rounded-full" />
            </div>
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function MemoriesView() {
  const { t } = useTranslation()
  const { mode } = useWorkspace()
  const initialize = useMemoryStore((s) => s.initialize)
  const index = useMemoryStore((s) => s.index)
  const loading = useMemoryStore((s) => s.loading)
  const updateMemory = useMemoryStore((s) => s.update)
  const removeMemory = useMemoryStore((s) => s.remove)
  const settings = useAppSettings((s) => s.settings)
  const updateSettings = useAppSettings((s) => s.update)
  const [query, setQuery] = useState("")
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS)
  const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORIES)
  const [tab, setTab] = useState<"list" | "graph">("list")
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    void initialize()
  }, [initialize])

  const projects = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of index) {
      if (m.kind === "project" && m.projectId) map.set(m.projectId, m.projectName ?? m.projectId)
      // A project whose memories are all general still deserves an entry in the
      // selector — otherwise they would become unreachable through the filter.
      else if (m.originProjectId && !map.has(m.originProjectId)) {
        map.set(m.originProjectId, m.originProjectName ?? m.originProjectId)
      }
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [index])

  const kinds: MemoryKind[] = mode === "chat" ? ["core", "seasonal", "general"] : ["project", "general"]

  /**
   * Routine proposals. They stay OUTSIDE the pool — they are not memories yet —
   * and have their own block, visible in both modes, until accepted or discarded.
   */
  const proposals = useMemo(() => index.filter((m) => m.proposed), [index])

  // Visible pool (mode + project, without search and without category) — the graph highlights
  // instead of hiding, and it is from it that the filter counts come.
  const basePool = useMemo(() => {
    const now = Date.now()
    return index.filter((m) => {
      // A proposal has its own block and does not enter the list as a memory.
      if (m.proposed) return false
      if (!kinds.includes(m.kind)) return false
      // A single rule: the memory appears in the mode in which it counts. It is what keeps
      // learnings out of the chat and conversation preference out of the code.
      if (!visibleIn(m, mode)) return false
      if (m.expiresAt != null && m.expiresAt < now) return false
      // The project filter counts for ALL kinds, not only "project": a
      // general memory created inside another project does not belong to this view.
      // The ones without a recorded origin (work preferences) keep counting in
      // any project — what decides that is matchesProjectFilter.
      if (projectFilter !== ALL_PROJECTS && !matchesProjectFilter(m, projectFilter)) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, mode, projectFilter])

  /** Only the categories that exist in the view become an option — with the count next to it. */
  const categories = useMemo(() => {
    const counts = new Map<ProjectCategory, number>()
    for (const m of basePool) if (m.category) counts.set(m.category, (counts.get(m.category) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [basePool])

  const pool = useMemo(
    () => (categoryFilter === ALL_CATEGORIES ? basePool : basePool.filter((m) => m.category === categoryFilter)),
    [basePool, categoryFilter],
  )

  const filtered = useMemo(() => {
    if (query.trim()) return searchMemories(pool, query, 50)
    return [...pool].sort((a, b) => lastActivity(b) - lastActivity(a))
  }, [pool, query])

  // Folder of the focused project — files dropped in the graph become memories of it
  const projectDirectory = useMemo(() => {
    const focusId = projectFilter !== ALL_PROJECTS ? projectFilter : projects.length === 1 ? projects[0].id : null
    if (!focusId) return undefined
    return pool.find((m) => m.projectId === focusId && m.directory)?.directory
  }, [pool, projectFilter, projects])

  const byId = useMemo(() => new Map(index.map((m) => [m.id, m])), [index])
  const selected = selectedId ? byId.get(selectedId) : undefined

  /**
   * Neighbors resolved once per index. Before, this was recalculated per card
   * on every render, creating a new array — which nullified the MemoryCard memo.
   */
  const relatedByMemory = useMemo(() => {
    const map = new Map<string, Memory[]>()
    for (const memory of index) {
      const list = memory.relatedIds
        .map((id) => byId.get(id))
        .filter((m): m is Memory => m != null)
      if (list.length > 0) map.set(memory.id, list)
    }
    return map
  }, [index, byId])
  const relatedOf = useCallback(
    (memory: Memory) => relatedByMemory.get(memory.id) ?? EMPTY_RELATED,
    [relatedByMemory],
  )

  const handleSelect = useCallback(
    (id: string) => setSelectedId((prev) => (prev === id ? null : id)),
    [],
  )

  // Accepting keeps the memory (and the weekly promotion may promote it); discarding
  // erases the proposal for good.
  const acceptProposal = useCallback(
    (id: string) => void updateMemory(id, { proposed: false }),
    [updateMemory],
  )
  const discardProposal = useCallback((id: string) => void removeMemory(id), [removeMemory])

  // Infinite scroll: rendering 300+ cards at once froze the tab.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Any change in the displayed set restarts the pagination — otherwise a new
  // search would inherit the already expanded total of the previous one.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [query, projectFilter, mode, tab])

  // Switching mode or project may leave the chosen category out of the
  // view — it goes back to "all" instead of showing an empty list for no reason.
  useEffect(() => {
    setCategoryFilter(ALL_CATEGORIES)
  }, [mode, projectFilter])

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])
  const hasMore = visibleCount < filtered.length

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore || tab !== "list") return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisibleCount((c) => c + PAGE_SIZE)
      },
      // The root is the scrollable container, not the viewport: rootMargin only anticipates the
      // loading if it is measured on the same element that scrolls.
      { root: scrollRef.current, rootMargin: "400px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, tab, visible.length])

  return (
    <div className="flex h-full min-w-0 flex-col gap-3 overflow-hidden">
      {/* Memory routine: the switch and, when there are any, the proposals of the day. */}
      <div className="rounded-lg border bg-card px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium">{t("memories.routine.title")}</span>
          <Select
            value={settings.memoryRoutine}
            onValueChange={(v) =>
              updateSettings({ memoryRoutine: (v ?? "off") as MemoryRoutineMode })
            }
          >
            <SelectTrigger className="h-7 w-44">
              <SelectValue>{t(`memories.routine.${routineKey(settings.memoryRoutine)}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value="off">{t("memories.routine.off")}</SelectItem>
              <SelectItem value="daily">{t("memories.routine.daily")}</SelectItem>
              <SelectItem value="weekly">{t("memories.routine.weekly")}</SelectItem>
              <SelectItem value="daily+weekly">{t("memories.routine.dailyWeekly")}</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-[11px] text-muted-foreground">
            {settings.auxModel
              ? t("memories.routine.model", { model: settings.auxModel.modelId })
              : t("memories.routine.needsModel")}
          </span>
        </div>
        {proposals.length > 0 && (
          <ul className="mt-2 space-y-1 border-t pt-2">
            {proposals.map((proposal) => (
              <li key={proposal.id} className="flex items-start gap-2 text-xs">
                <span className="min-w-0 flex-1 leading-snug">{proposal.text}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
                  onClick={() => acceptProposal(proposal.id)}
                >
                  <Check className="size-3" /> {t("memories.routine.accept")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 gap-1 px-1.5 text-[11px] text-muted-foreground"
                  onClick={() => discardProposal(proposal.id)}
                >
                  <X className="size-3" /> {t("memories.routine.discard")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("memories.searchPlaceholder")}
            className="pl-8"
          />
        </div>
        {mode === "code" && projects.length > 1 && (
          <Select value={projectFilter} onValueChange={(v) => setProjectFilter(v ?? ALL_PROJECTS)}>
            <SelectTrigger className="w-44">
              <SelectValue>
                {projectFilter === ALL_PROJECTS ? t("memories.allProjects") : projects.find((p) => p.id === projectFilter)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value={ALL_PROJECTS}>{t("memories.allProjectsFull")}</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {categories.length > 1 && (
          <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v ?? ALL_CATEGORIES)}>
            <SelectTrigger className="w-40">
              <SelectValue>
                {categoryFilter === ALL_CATEGORIES
                  ? t("memories.allCategories")
                  : t(`memories.categories.${categoryFilter}`, {
                      defaultValue: CATEGORY_LABEL[categoryFilter as ProjectCategory],
                    })}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value={ALL_CATEGORIES}>{t("memories.allCategories")}</SelectItem>
              {categories.map(([category, count]) => (
                <SelectItem key={category} value={category}>
                  {t(`memories.categories.${category}`, { defaultValue: CATEGORY_LABEL[category] })} ({count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Tabs value={tab} onValueChange={(v) => setTab(v as "list" | "graph")}>
          <TabsList>
            <TabsTrigger value="list" className="gap-1.5">
              <List className="size-3.5" /> {t("memories.tabList")}
            </TabsTrigger>
            <TabsTrigger value="graph" className="gap-1.5">
              <Network className="size-3.5" /> {t("memories.tabGraph")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
      {loading ? (
        <MemoriesSkeleton graph={tab === "graph"} />
      ) : (tab === "graph" ? pool : filtered).length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-1 text-center">
            <p className="text-sm font-medium">{t(query ? "memories.emptyTitleQuery" : "memories.emptyTitleNone")}</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {query
                ? t("memories.emptyQuery")
                : mode === "chat"
                  ? t("memories.emptyChat")
                  : t("memories.emptyCode")}
            </p>
          </div>
        </div>
      ) : tab === "list" ? (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
          {/* One column less with the panel open — the remaining space does not
              fit three cards without squeezing the text. */}
          <div
            className={cn(
              "grid grid-cols-1 gap-2",
              selected ? "xl:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-3",
            )}
          >
            {visible.map((memory) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                related={relatedOf(memory)}
                selected={memory.id === selectedId}
                onSelect={handleSelect}
                // Before this it jumped to the Graph tab; with the shared panel
                // swapping the selection is enough, without taking the user out of the list.
                onSelectRelated={setSelectedId}
              />
            ))}
          </div>
          {hasMore && (
            <div ref={sentinelRef} className="grid grid-cols-1 gap-2 pt-2">
              <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          )}
        </div>
      ) : (
        <MemoryGraph
          pool={pool}
          query={query}
          selectedId={selectedId}
          onSelect={setSelectedId}
          projectDirectory={projectDirectory}
        />
      )}
      {/* Single panel of the two tabs: clicking a card or a node of the graph opens
          the same detail, with the document filling the remaining height. */}
      {selected && (
        <MemoryDetailPanel
          memory={selected}
          related={relatedOf(selected)}
          onSelectRelated={setSelectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
      </div>
    </div>
  )
}
