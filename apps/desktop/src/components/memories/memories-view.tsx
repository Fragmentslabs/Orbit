import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, List, Network, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useWorkspace } from "@/lib/workspace-context"
import type { Memory, MemoryKind, ProjectCategory } from "@shared/memory"
import { searchMemories, visibleIn } from "@shared/memory"
import { matchesProjectFilter } from "@shared/memory-layout"
import { useMemoryStore } from "@/src/stores/memory-store"
import { useActiveSession } from "@/src/stores/session-store"
import { useViewScope } from "@/src/stores/view-scope-store"
import { ORPHAN_KEY, usePanelStore } from "@/src/stores/panel-store"
import { type FilterGroup, MemoryFilters } from "./memory-filters"
import { MemoryListItem } from "./memory-list-item"
import { MemoryGraph } from "./memory-graph"
import { CATEGORY_LABEL, KIND_COLOR, KIND_LABEL, lastActivity } from "./meta"

/**
 * Memories view: list of cards or tree of connections (SVG with zoom/pan),
 * with a filter by scope (chosen in the header; by default the workspace mode) — chat shows
 * core+seasonal+general, code shows project+general (project filter).
 *
 * The filters live in a menu on the right (same shape as the Tools page). Choosing a
 * project restricts the view to what belongs to it: the project memories plus the
 * general ones created there. General ones from other projects stay out — to see them,
 * set the filter back to "all projects".
 *
 * Opening a memory (card or graph node) does not take over the page: the detail opens
 * as a tab of the side panel, the same one a citation in the chat opens.
 */

const ALL = "__all__"

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
  const { mode: workspaceMode } = useWorkspace()
  // What the page lists is chosen in the header (chat, code or both); until then it follows
  // the workspace mode, as it always did.
  const [scope] = useViewScope("memories", workspaceMode)
  const initialize = useMemoryStore((s) => s.initialize)
  const index = useMemoryStore((s) => s.index)
  const loading = useMemoryStore((s) => s.loading)
  const updateMemory = useMemoryStore((s) => s.update)
  const removeMemory = useMemoryStore((s) => s.remove)
  const openMemoryTab = usePanelStore((s) => s.openMemoryTab)
  const [query, setQuery] = useState("")
  const [projectFilter, setProjectFilter] = useState(ALL)
  const [kindFilter, setKindFilter] = useState(ALL)
  const [categoryFilter, setCategoryFilter] = useState(ALL)
  const [tab, setTab] = useState<"list" | "graph">("list")

  // The panel belongs to the active conversation of the mode (same key the layout uses).
  const activeKey = useActiveSession(workspaceMode)?.id ?? ORPHAN_KEY
  // Memory open in the active tab of the panel — it is the highlighted card/node.
  const openedId = usePanelStore((s) => {
    const activeTab = s.activeTabBySession[activeKey]
    return s.tabsBySession[activeKey]?.find((tb) => tb.id === activeTab && tb.type === "memory")?.memoryId
  })

  useEffect(() => {
    void initialize()
  }, [initialize])

  const projects = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of index) {
      if (m.kind === "project" && m.projectId) map.set(m.projectId, m.projectName ?? m.projectId)
      // A project whose memories are all general still deserves an entry in the
      // filter — otherwise they would become unreachable through it.
      else if (m.originProjectId && !map.has(m.originProjectId)) {
        map.set(m.originProjectId, m.originProjectName ?? m.originProjectId)
      }
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [index])

  const kinds: MemoryKind[] =
    scope === "chat"
      ? ["core", "seasonal", "general"]
      : scope === "code"
        ? ["project", "general"]
        : ["core", "seasonal", "general", "project"]
  /** The memory shows up where it counts; "all" is the union of both modes. */
  const countsInScope = (m: Memory) => (scope === "all" ? visibleIn(m, "chat") || visibleIn(m, "code") : visibleIn(m, scope))

  /**
   * Routine proposals. They stay OUTSIDE the pool — they are not memories yet —
   * and have their own block, visible in both modes, until accepted or discarded.
   */
  const proposals = useMemo(() => index.filter((m) => m.proposed), [index])

  // Visible pool (mode + project, without kind, search and category) — the filter
  // counts come from it.
  const basePool = useMemo(() => {
    const now = Date.now()
    return index.filter((m) => {
      // A proposal has its own block and does not enter the list as a memory.
      if (m.proposed) return false
      if (!kinds.includes(m.kind)) return false
      // A single rule: the memory appears in the mode in which it counts. It is what keeps
      // learnings out of the chat and conversation preference out of the code.
      if (!countsInScope(m)) return false
      if (m.expiresAt != null && m.expiresAt < now) return false
      // The project filter counts for ALL kinds, not only "project": a
      // general memory created inside another project does not belong to this view.
      // The ones without a recorded origin (work preferences) keep counting in
      // any project — what decides that is matchesProjectFilter.
      if (projectFilter !== ALL && !matchesProjectFilter(m, projectFilter)) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, scope, projectFilter])

  const kindPool = useMemo(
    () => (kindFilter === ALL ? basePool : basePool.filter((m) => m.kind === kindFilter)),
    [basePool, kindFilter],
  )

  const pool = useMemo(
    () => (categoryFilter === ALL ? kindPool : kindPool.filter((m) => m.category === categoryFilter)),
    [kindPool, categoryFilter],
  )

  const filtered = useMemo(() => {
    if (query.trim()) return searchMemories(pool, query, 50)
    return [...pool].sort((a, b) => lastActivity(b) - lastActivity(a))
  }, [pool, query])

  // Filter menu: only the options that exist in the view, each with its count.
  const filterGroups = useMemo<FilterGroup[]>(() => {
    const groups: FilterGroup[] = []

    if (scope !== "chat" && projects.length > 1) {
      const counts = new Map<string, number>()
      let total = 0
      for (const m of index) {
        if (m.proposed || !kinds.includes(m.kind) || !countsInScope(m)) continue
        total++
        for (const p of projects) if (matchesProjectFilter(m, p.id)) counts.set(p.id, (counts.get(p.id) ?? 0) + 1)
      }
      groups.push({
        id: "project",
        label: t("memories.filters.project"),
        value: projectFilter,
        onChange: setProjectFilter,
        options: [
          { value: ALL, label: t("memories.allProjects"), count: total },
          ...projects.map((p) => ({ value: p.id, label: p.name, count: counts.get(p.id) ?? 0 })),
        ],
      })
    }

    groups.push({
      id: "kind",
      label: t("memories.filters.kind"),
      value: kindFilter,
      onChange: setKindFilter,
      options: [
        { value: ALL, label: t("memories.filters.all"), count: basePool.length },
        ...kinds.map((kind) => ({
          value: kind,
          label: t(`memories.kinds.${kind}`, { defaultValue: KIND_LABEL[kind] }),
          count: basePool.filter((m) => m.kind === kind).length,
          color: KIND_COLOR[kind],
        })),
      ],
    })

    const counts = new Map<ProjectCategory, number>()
    for (const m of kindPool) if (m.category) counts.set(m.category, (counts.get(m.category) ?? 0) + 1)
    if (counts.size > 0) {
      groups.push({
        id: "category",
        label: t("memories.filters.category"),
        value: categoryFilter,
        onChange: setCategoryFilter,
        options: [
          { value: ALL, label: t("memories.filters.all"), count: kindPool.length },
          ...[...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([category, count]) => ({
              value: category,
              label: t(`memories.categories.${category}`, { defaultValue: CATEGORY_LABEL[category] }),
              count,
            })),
        ],
      })
    }
    return groups
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, scope, projects, index, projectFilter, kindFilter, categoryFilter, basePool, kindPool])

  // Folder of the focused project — files dropped in the graph become memories of it
  const projectDirectory = useMemo(() => {
    const focusId = projectFilter !== ALL ? projectFilter : projects.length === 1 ? projects[0].id : null
    if (!focusId) return undefined
    return pool.find((m) => m.projectId === focusId && m.directory)?.directory
  }, [pool, projectFilter, projects])

  const byId = useMemo(() => new Map(index.map((m) => [m.id, m])), [index])

  // Card or node: both open the memory as a tab of the side panel. Clicking the
  // background of the graph (null) only deselects — nothing to close here.
  const openMemory = useCallback(
    (id: string | null) => {
      if (!id) return
      const memory = byId.get(id)
      const text = memory?.title?.trim() || memory?.text.replace(/\s+/g, " ").trim() || id
      openMemoryTab(activeKey, { memoryId: id, title: text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text })
    },
    [byId, openMemoryTab, activeKey],
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
  }, [query, projectFilter, kindFilter, categoryFilter, scope, tab])

  // Switching mode or project may leave the chosen kind/category out of the
  // view — they go back to "all" instead of showing an empty list for no reason.
  useEffect(() => {
    setKindFilter(ALL)
    setCategoryFilter(ALL)
  }, [scope, projectFilter])

  // A kind change may also leave the category out of the view.
  useEffect(() => {
    setCategoryFilter(ALL)
  }, [kindFilter])

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
    <div className="flex h-full min-w-0 gap-3 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden">
        {/* Routine proposals: the switch itself lives in Preferences → General. */}
        {proposals.length > 0 && (
          <div className="rounded-lg border bg-card px-3 py-2">
            <ul className="space-y-1">
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
          </div>
        )}
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

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {loading ? (
            <MemoriesSkeleton graph={tab === "graph"} />
          ) : (tab === "graph" ? pool : filtered).length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="flex flex-col items-center gap-1 text-center">
                <p className="text-sm font-medium">{t(query ? "memories.emptyTitleQuery" : "memories.emptyTitleNone")}</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  {query
                    ? t("memories.emptyQuery")
                    : scope === "code"
                      ? t("memories.emptyCode")
                      : t("memories.emptyChat")}
                </p>
              </div>
            </div>
          ) : tab === "list" ? (
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                {visible.map((memory) => (
                  <MemoryListItem
                    key={memory.id}
                    memory={memory}
                    selected={memory.id === openedId}
                    onOpen={openMemory}
                  />
                ))}
              </div>
              {hasMore && (
                <div ref={sentinelRef} className="grid grid-cols-1 gap-2 pt-2">
                  <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <MemoryGraph
              pool={pool}
              query={query}
              selectedId={openedId ?? null}
              onSelect={openMemory}
              projectDirectory={projectDirectory}
            />
          )}
        </div>
      </div>

      <MemoryFilters groups={filterGroups} label={t("memories.filters.label")} />
    </div>
  )
}
