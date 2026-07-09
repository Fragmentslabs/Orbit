import { useEffect, useMemo, useState } from "react"
import { List, Network, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useWorkspace } from "@/lib/workspace-context"
import type { Memory, MemoryKind } from "@/shared/memory"
import { searchMemories } from "@/shared/memory"
import { useMemoryStore } from "@/src/stores/memory-store"
import { MemoryCard } from "./memory-card"
import { MemoryTree } from "./memory-tree"
import { lastActivity } from "./meta"

/**
 * View de Memórias: lista de cards ou árvore de conexões (SVG), com filtro
 * automático pelo modo do workspace — chat mostra core+seasonal+general,
 * código mostra project+general (com seletor de projeto).
 */

const ALL_PROJECTS = "__all__"

export function MemoriesView() {
  const { mode } = useWorkspace()
  const initialize = useMemoryStore((s) => s.initialize)
  const index = useMemoryStore((s) => s.index)
  const [query, setQuery] = useState("")
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS)
  const [tab, setTab] = useState<"list" | "tree">("list")
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    void initialize()
  }, [initialize])

  const projects = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of index) {
      if (m.kind === "project" && m.projectId) map.set(m.projectId, m.projectName ?? m.projectId)
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [index])

  const kinds: MemoryKind[] = mode === "chat" ? ["core", "seasonal", "general"] : ["project", "general"]

  const filtered = useMemo(() => {
    const now = Date.now()
    let pool = index.filter((m) => {
      if (!kinds.includes(m.kind)) return false
      if (m.expiresAt != null && m.expiresAt < now) return false
      if (
        m.kind === "project" &&
        projectFilter !== ALL_PROJECTS &&
        m.projectId !== projectFilter
      ) {
        return false
      }
      return true
    })
    if (query.trim()) pool = searchMemories(pool, query, 50)
    else pool = [...pool].sort((a, b) => lastActivity(b) - lastActivity(a))
    return pool
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, mode, query, projectFilter])

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
            placeholder="Buscar memórias…"
            className="pl-8"
          />
        </div>
        {mode === "code" && projects.length > 1 && (
          <Select value={projectFilter} onValueChange={(v) => setProjectFilter(v ?? ALL_PROJECTS)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>Todos os projetos</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Tabs value={tab} onValueChange={(v) => setTab(v as "list" | "tree")}>
          <TabsList>
            <TabsTrigger value="list" className="gap-1.5">
              <List className="size-3.5" /> Lista
            </TabsTrigger>
            <TabsTrigger value="tree" className="gap-1.5">
              <Network className="size-3.5" /> Árvore
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-1 text-center">
            <p className="text-sm font-medium">Nenhuma memória {query ? "encontrada" : "ainda"}</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {query
                ? "Tente outros termos de busca."
                : mode === "chat"
                  ? "Converse com o Brain ativo e o Orbit passa a lembrar fatos e preferências automaticamente."
                  : "Trabalhe em um projeto com o Brain ativo e o Orbit memoriza decisões, convenções e estrutura."}
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
                  setTab("tree")
                }}
              />
            ))}
          </div>
        </div>
      ) : (
        <MemoryTree
          memories={filtered}
          allById={byId}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}
    </div>
  )
}
