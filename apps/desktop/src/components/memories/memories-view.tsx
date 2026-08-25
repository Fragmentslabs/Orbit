import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { List, Network, Search } from "lucide-react"
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
import { useWorkspace } from "@/lib/workspace-context"
import type { Memory, MemoryKind } from "@shared/memory"
import { isCodeContext, searchMemories } from "@shared/memory"
import { matchesProjectFilter } from "@shared/memory-layout"
import { useMemoryStore } from "@/src/stores/memory-store"
import { MemoryCard } from "./memory-card"
import { MemoryGraph } from "./memory-graph"
import { lastActivity } from "./meta"

/**
 * View de Memórias: lista de cards ou árvore de conexões (SVG com zoom/pan),
 * com filtro automático pelo modo do workspace — chat mostra
 * core+seasonal+general, código mostra project+general (seletor de projeto).
 *
 * Escolher um projeto no seletor restringe a vista ao que pertence a ele: as
 * memórias do projeto mais as gerais criadas ali. Gerais de outros projetos
 * ficam de fora — para vê-las, volte o seletor para "todos os projetos".
 */

const ALL_PROJECTS = "__all__"

/**
 * Placeholder do carregamento inicial. Sem ele a tela pisca o estado vazio
 * ("nenhuma memória") antes do índice chegar do main, o que lê como se não
 * houvesse nada salvo.
 */
function MemoriesSkeleton({ graph }: { graph: boolean }) {
  if (graph) {
    return (
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border">
        {/* Nós esparsos, no espírito do grafo que vai aparecer */}
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
  const [query, setQuery] = useState("")
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS)
  const [tab, setTab] = useState<"list" | "graph">("list")
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    void initialize()
  }, [initialize])

  const projects = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of index) {
      if (m.kind === "project" && m.projectId) map.set(m.projectId, m.projectName ?? m.projectId)
      // Um projeto cujas memórias são todas gerais ainda merece entrada no
      // seletor — senão elas ficariam inalcançáveis pelo filtro.
      else if (m.originProjectId && !map.has(m.originProjectId)) {
        map.set(m.originProjectId, m.originProjectName ?? m.originProjectId)
      }
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [index])

  const kinds: MemoryKind[] = mode === "chat" ? ["core", "seasonal", "general"] : ["project", "general"]

  // Pool visível (modo + projeto, sem a busca) — o grafo destaca em vez de esconder
  const pool = useMemo(() => {
    const now = Date.now()
    return index.filter((m) => {
      if (!kinds.includes(m.kind)) return false
      // "general" existe nos dois modos, mas os aprendizados gravados sob ele
      // são conhecimento de código — no chat eles não entram.
      if (mode === "chat" && isCodeContext(m)) return false
      if (m.expiresAt != null && m.expiresAt < now) return false
      // O filtro de projeto vale para TODOS os kinds, não só "project": uma
      // memória geral criada dentro de outro projeto não pertence a esta vista.
      // As sem origem registrada (preferências de trabalho) seguem valendo em
      // qualquer projeto — quem decide isso é matchesProjectFilter.
      if (projectFilter !== ALL_PROJECTS && !matchesProjectFilter(m, projectFilter)) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, mode, projectFilter])

  const filtered = useMemo(() => {
    if (query.trim()) return searchMemories(pool, query, 50)
    return [...pool].sort((a, b) => lastActivity(b) - lastActivity(a))
  }, [pool, query])

  // Pasta do projeto em foco — arquivos soltos no grafo viram memórias dele
  const projectDirectory = useMemo(() => {
    const focusId = projectFilter !== ALL_PROJECTS ? projectFilter : projects.length === 1 ? projects[0].id : null
    if (!focusId) return undefined
    return pool.find((m) => m.projectId === focusId && m.directory)?.directory
  }, [pool, projectFilter, projects])

  const byId = useMemo(() => new Map(index.map((m) => [m.id, m])), [index])
  const relatedOf = (memory: Memory) =>
    memory.relatedIds.map((id) => byId.get(id)).filter((m): m is Memory => m != null)

  return (
    <div className="flex h-full min-w-0 flex-col gap-3 overflow-hidden">
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
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((memory) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                related={relatedOf(memory)}
                onSelectRelated={(id) => {
                  setSelectedId(id)
                  setTab("graph")
                }}
              />
            ))}
          </div>
        </div>
      ) : (
        <MemoryGraph
          pool={pool}
          allById={byId}
          query={query}
          selectedId={selectedId}
          onSelect={setSelectedId}
          projectDirectory={projectDirectory}
        />
      )}
    </div>
  )
}
