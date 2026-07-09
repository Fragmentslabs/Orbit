import { useMemo, useState } from "react"
import { Expand, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Memory } from "@/shared/memory"
import { MemoryCard } from "./memory-card"
import { KIND_COLOR, KIND_LABEL } from "./meta"

/**
 * Árvore de conexões das memórias: layout hierárquico esquerda→direita em SVG
 * puro (BFS por níveis de relatedIds). Não é force-directed de propósito —
 * a temporalidade importa (raízes são as memórias mais antigas).
 *
 * Interações: hover = tooltip; click = card lateral; double-click = re-enraíza
 * a árvore no nó; "Expandir tudo" inclui vizinhos fora do filtro (nível 2-3).
 */

const COL_WIDTH = 250
const ROW_GAP = 14
const MARGIN = 24
const MAX_LABEL = 26

interface TreeNode {
  memory: Memory
  level: number
  x: number
  y: number
  w: number
  h: number
}

interface TreeEdge {
  from: string
  to: string
  hits: number
}

function nodeSize(memory: Memory): { w: number; h: number } {
  const label = memory.text.length > MAX_LABEL ? `${memory.text.slice(0, MAX_LABEL)}…` : memory.text
  // tamanho ∝ weight: pills de memórias importantes são maiores
  const scale = 0.85 + memory.weight * 0.35
  return { w: Math.max(72, label.length * 6.6 + 28) * scale, h: 26 * scale }
}

function buildGraph(
  memories: Memory[],
  allById: Map<string, Memory>,
  rootId: string | null,
  expandAll: boolean,
): { nodes: TreeNode[]; edges: TreeEdge[]; width: number; height: number } {
  // 1. Conjunto de nós: filtrados + vizinhos via relatedIds (profundidade 1, ou 3 no expandir tudo)
  const depth = expandAll ? 3 : 1
  const included = new Map<string, Memory>()
  let frontier = memories
  for (const m of memories) included.set(m.id, m)
  for (let d = 0; d < depth; d++) {
    const next: Memory[] = []
    for (const m of frontier) {
      for (const id of m.relatedIds) {
        if (included.has(id)) continue
        const neighbor = allById.get(id)
        if (neighbor) {
          included.set(id, neighbor)
          next.push(neighbor)
        }
      }
    }
    frontier = next
  }

  // 2. Níveis por BFS. Com raiz explícita, só o subgrafo alcançável a partir dela.
  const levelOf = new Map<string, number>()
  const bfs = (startId: string, startLevel: number) => {
    const queue: Array<{ id: string; level: number }> = [{ id: startId, level: startLevel }]
    while (queue.length) {
      const { id, level } = queue.shift()!
      if (levelOf.has(id)) continue
      levelOf.set(id, level)
      const memory = included.get(id)
      if (!memory) continue
      for (const rel of memory.relatedIds) {
        if (included.has(rel) && !levelOf.has(rel)) queue.push({ id: rel, level: level + 1 })
      }
    }
  }

  if (rootId && included.has(rootId)) {
    bfs(rootId, 0)
  } else {
    // Raízes = memórias mais antigas de cada componente (temporalidade → esquerda)
    const seeds = [...included.values()].sort((a, b) => a.createdAt - b.createdAt)
    for (const seed of seeds) if (!levelOf.has(seed.id)) bfs(seed.id, 0)
  }

  // 3. Layout em colunas: x = nível; dentro da coluna, ordena por createdAt
  const byLevel = new Map<number, Memory[]>()
  for (const [id, level] of levelOf) {
    const memory = included.get(id)!
    const bucket = byLevel.get(level) ?? []
    bucket.push(memory)
    byLevel.set(level, bucket)
  }

  const nodes: TreeNode[] = []
  let height = 0
  for (const [level, bucket] of byLevel) {
    bucket.sort((a, b) => a.createdAt - b.createdAt)
    let y = MARGIN
    for (const memory of bucket) {
      const { w, h } = nodeSize(memory)
      nodes.push({ memory, level, x: MARGIN + level * COL_WIDTH, y, w, h })
      y += h + ROW_GAP
    }
    height = Math.max(height, y)
  }
  const maxLevel = Math.max(0, ...byLevel.keys())
  const width = MARGIN * 2 + (maxLevel + 1) * COL_WIDTH

  // 4. Arestas (deduplicadas por par) entre nós presentes no grafo
  const edges: TreeEdge[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    for (const rel of node.memory.relatedIds) {
      if (!levelOf.has(rel)) continue
      const key = [node.memory.id, rel].sort().join(":")
      if (seen.has(key)) continue
      seen.add(key)
      const other = included.get(rel)!
      edges.push({
        from: node.memory.id,
        to: rel,
        hits: node.memory.hits + other.hits,
      })
    }
  }

  return { nodes, edges, width, height: height + MARGIN }
}

export function MemoryTree({ memories, allById, selectedId, onSelect }: {
  memories: Memory[]
  allById: Map<string, Memory>
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const [rootId, setRootId] = useState<string | null>(null)
  const [expandAll, setExpandAll] = useState(false)

  const { nodes, edges, width, height } = useMemo(
    () => buildGraph(memories, allById, rootId, expandAll),
    [memories, allById, rootId, expandAll],
  )
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.memory.id, n])), [nodes])
  const selected = selectedId ? allById.get(selectedId) : undefined
  const rootMemory = rootId ? allById.get(rootId) : undefined

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button
            variant={expandAll ? "secondary" : "outline"}
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setExpandAll((v) => !v)}
          >
            <Expand className="size-3.5" />
            {expandAll ? "Recolher" : "Expandir tudo"}
          </Button>
          {rootMemory && (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => setRootId(null)}
              title="Voltar à visão completa"
            >
              raiz: <span className="max-w-40 truncate">{rootMemory.text}</span>
              <X className="size-3" />
            </Button>
          )}
          <span className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
            {(Object.keys(KIND_COLOR) as Array<keyof typeof KIND_COLOR>).map((kind) => (
              <span key={kind} className="flex items-center gap-1">
                <span className="size-2 rounded-full" style={{ backgroundColor: KIND_COLOR[kind] }} />
                {KIND_LABEL[kind]}
              </span>
            ))}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card/50">
          <svg width={width} height={height} className="min-h-full min-w-full">
            <defs>
              <marker
                id="memory-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" className="fill-muted-foreground/50" />
              </marker>
            </defs>
            {edges.map((edge) => {
              const a = nodeById.get(edge.from)
              const b = nodeById.get(edge.to)
              if (!a || !b) return null
              // Esquerda→direita: origem é o nó de nível menor
              const [src, dst] = a.level <= b.level ? [a, b] : [b, a]
              const x1 = src.x + src.w
              const y1 = src.y + src.h / 2
              const x2 = dst.x
              const y2 = dst.y + dst.h / 2
              const mx = (x1 + x2) / 2
              const strokeWidth = 1 + Math.min(edge.hits / 10, 2)
              return (
                <path
                  key={`${edge.from}:${edge.to}`}
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  strokeWidth={strokeWidth}
                  markerEnd="url(#memory-arrow)"
                  className="stroke-muted-foreground/40"
                />
              )
            })}
            {nodes.map((node) => {
              const { memory } = node
              const label =
                memory.text.length > MAX_LABEL ? `${memory.text.slice(0, MAX_LABEL)}…` : memory.text
              const isSelected = memory.id === selectedId
              return (
                <g
                  key={memory.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  className="cursor-pointer"
                  onClick={() => onSelect(isSelected ? null : memory.id)}
                  onDoubleClick={() => setRootId(memory.id)}
                >
                  <title>{`[${KIND_LABEL[memory.kind]}] ${memory.text}\npeso ${memory.weight.toFixed(2)} · ${memory.hits} usos`}</title>
                  <rect
                    width={node.w}
                    height={node.h}
                    rx={node.h / 2}
                    fill={KIND_COLOR[memory.kind]}
                    fillOpacity={isSelected ? 0.35 : 0.16}
                    stroke={KIND_COLOR[memory.kind]}
                    strokeWidth={isSelected ? 2 : 1.2}
                  />
                  <text
                    x={node.w / 2}
                    y={node.h / 2}
                    dominantBaseline="central"
                    textAnchor="middle"
                    className="fill-foreground select-none"
                    fontSize={11}
                  >
                    {label}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
      </div>
      {selected && (
        <div className="w-80 shrink-0 overflow-y-auto">
          <MemoryCard
            memory={selected}
            related={selected.relatedIds
              .map((id) => allById.get(id))
              .filter((m): m is Memory => m != null)}
            onSelectRelated={onSelect}
          />
        </div>
      )}
    </div>
  )
}
