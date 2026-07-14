import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { BrainCircuit, Briefcase, Crosshair, FileUp, Layers, Link2, Palette, Server, Shield, SlidersHorizontal, Terminal } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Memory } from "@shared/memory"
import { jaccard, normalizeText, PROJECT_AREAS } from "@shared/memory"
import { memoryApi } from "@/src/lib/ipc"
import { MemoryCard } from "./memory-card"
import { AREA_ICON, KIND_COLOR, KIND_LABEL, lastActivity } from "./meta"

/**
 * Grafo de memórias (fase 3): projeto no centro (área overview), áreas de
 * conhecimento ao redor, memórias ligadas como filhos e avulsas na periferia.
 *
 * - Zoom (wheel) + pan (arrastar fundo); "Centralizar" reenquadra
 * - Click abre a memória no painel lateral; Ctrl+click em dois nodes cria aresta
 * - Busca da view destaca nodes que batem (demais ficam esmaecidos)
 * - Node recém-usado ganha anel; desatualizado (30d sem uso) fica opaco
 * - Arestas explícitas (relatedIds) sólidas; relações inferidas por tags, tracejadas
 * - Arrastar um arquivo de texto para o grafo cria um node de memória
 */

const ICON_MAP: Record<string, LucideIcon> = {
  BrainCircuit, Briefcase, Palette, Layers, SlidersHorizontal, Server, Shield, Terminal,
}

const LEVEL_RADIUS = 150
const CLUSTER_PAD = 90
const LOOSE_RING_PAD = 110
const RECENT_MS = 7 * 24 * 60 * 60 * 1000
const STALE_MS = 30 * 24 * 60 * 60 * 1000
const INFERRED_JACCARD = 0.5
const MAX_INFERRED_EDGES = 30
const MAX_DROP_FILE_SIZE = 512 * 1024

interface GraphNode {
  memory: Memory
  x: number
  y: number
  r: number
  isRoot: boolean
}

interface GraphEdge {
  from: string
  to: string
  inferred: boolean
  hits: number
}

function nodeRadius(memory: Memory, isRoot: boolean): number {
  if (isRoot) return 30
  if (memory.area) return 20
  return 11 + memory.weight * 5
}

function nodeLabel(memory: Memory, isRoot: boolean): string {
  if (isRoot && memory.projectName) return memory.projectName
  if (memory.area) return PROJECT_AREAS[memory.area]?.label ?? memory.text
  return memory.text.length > 34 ? `${memory.text.slice(0, 34)}…` : memory.text
}

/** Componentes conexos por relatedIds (dentro do pool visível). */
function components(pool: Memory[]): Memory[][] {
  const byId = new Map(pool.map((m) => [m.id, m]))
  const seen = new Set<string>()
  const result: Memory[][] = []
  for (const memory of pool) {
    if (seen.has(memory.id)) continue
    const component: Memory[] = []
    const queue = [memory.id]
    while (queue.length) {
      const id = queue.pop()!
      if (seen.has(id)) continue
      const node = byId.get(id)
      if (!node) continue
      seen.add(id)
      component.push(node)
      for (const rel of node.relatedIds) if (byId.has(rel) && !seen.has(rel)) queue.push(rel)
    }
    result.push(component)
  }
  return result
}

/** Layout radial de um cluster: root no centro, níveis BFS em anéis. */
function layoutCluster(cluster: Memory[]): { nodes: GraphNode[]; radius: number } {
  const root =
    cluster.find((m) => m.area === "overview") ??
    [...cluster].sort((a, b) => b.weight - a.weight || a.createdAt - b.createdAt)[0]

  const byId = new Map(cluster.map((m) => [m.id, m]))
  const level = new Map<string, number>()
  const queue = [{ id: root.id, depth: 0 }]
  while (queue.length) {
    const { id, depth } = queue.shift()!
    if (level.has(id)) continue
    level.set(id, depth)
    for (const rel of byId.get(id)?.relatedIds ?? []) {
      if (byId.has(rel) && !level.has(rel)) queue.push({ id: rel, depth: depth + 1 })
    }
  }
  // Nós do componente inalcançáveis a partir do root (raro): último anel
  const maxKnown = Math.max(0, ...level.values())
  for (const m of cluster) if (!level.has(m.id)) level.set(m.id, maxKnown + 1)

  const byLevel = new Map<number, Memory[]>()
  for (const m of cluster) {
    const l = level.get(m.id)!
    const bucket = byLevel.get(l) ?? []
    bucket.push(m)
    byLevel.set(l, bucket)
  }

  const nodes: GraphNode[] = []
  for (const [depth, bucket] of byLevel) {
    bucket.sort((a, b) => a.createdAt - b.createdAt)
    if (depth === 0) {
      // nível 0 costuma ser só o root; múltiplos entram num anel mínimo
      bucket.forEach((m, i) => {
        const angle = (i / bucket.length) * 2 * Math.PI
        const r = bucket.length === 1 ? 0 : 40
        nodes.push({
          memory: m,
          x: Math.cos(angle) * r,
          y: Math.sin(angle) * r,
          r: nodeRadius(m, m.id === root.id),
          isRoot: m.id === root.id,
        })
      })
      continue
    }
    bucket.forEach((m, i) => {
      // -π/2: primeiro node no topo; offset por nível evita colunas alinhadas
      const angle = -Math.PI / 2 + (i / bucket.length) * 2 * Math.PI + depth * 0.35
      nodes.push({
        memory: m,
        x: Math.cos(angle) * depth * LEVEL_RADIUS,
        y: Math.sin(angle) * depth * LEVEL_RADIUS,
        r: nodeRadius(m, false),
        isRoot: false,
      })
    })
  }

  const maxLevel = Math.max(0, ...byLevel.keys())
  return { nodes, radius: maxLevel * LEVEL_RADIUS + 60 }
}

/** Layout completo: clusters em grade, memórias avulsas num anel periférico. */
function layoutGraph(pool: Memory[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const comps = components(pool)
  const clusters = comps.filter((c) => c.length > 1).sort((a, b) => b.length - a.length)
  const loose = comps.filter((c) => c.length === 1).map((c) => c[0])

  const nodes: GraphNode[] = []

  // Clusters em grade (2 colunas), célula proporcional ao raio do cluster
  const laid = clusters.map(layoutCluster)
  const cols = clusters.length > 1 ? 2 : 1
  let rowY = 0
  let rowHeight = 0
  let contentMaxRadius = 0
  laid.forEach((cluster, i) => {
    const col = i % cols
    if (col === 0 && i > 0) {
      rowY += rowHeight * 2 + CLUSTER_PAD
      rowHeight = 0
    }
    rowHeight = Math.max(rowHeight, cluster.radius)
    const cx = col * (2 * cluster.radius + CLUSTER_PAD * 2) + (col === 0 ? 0 : cluster.radius)
    const cy = rowY
    for (const node of cluster.nodes) {
      nodes.push({ ...node, x: node.x + cx, y: node.y + cy })
    }
    contentMaxRadius = Math.max(contentMaxRadius, Math.hypot(cx, cy) + cluster.radius)
  })

  // Avulsas: anel na periferia do conteúdo (ou grade quando não há clusters)
  if (loose.length > 0) {
    const ringRadius = Math.max(contentMaxRadius + LOOSE_RING_PAD, LEVEL_RADIUS * 1.4)
    loose.forEach((m, i) => {
      const angle = -Math.PI / 2 + (i / loose.length) * 2 * Math.PI
      nodes.push({
        memory: m,
        x: Math.cos(angle) * ringRadius,
        y: Math.sin(angle) * ringRadius,
        r: nodeRadius(m, false),
        isRoot: false,
      })
    })
  }

  // Arestas explícitas (relatedIds) + inferidas por similaridade de tags
  const present = new Map(nodes.map((n) => [n.memory.id, n]))
  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    for (const rel of node.memory.relatedIds) {
      if (!present.has(rel)) continue
      const key = [node.memory.id, rel].sort().join(":")
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({
        from: node.memory.id,
        to: rel,
        inferred: false,
        hits: node.memory.hits + present.get(rel)!.memory.hits,
      })
    }
  }
  // Índice de tags: cada tag → nodes que a possuem (evita O(n²) pairwise)
  const tagIndex = new Map<string, string[]>()
  for (const node of nodes) {
    for (const tag of node.memory.tags) {
      const key = normalizeText(tag)
      if (!tagIndex.has(key)) tagIndex.set(key, [])
      tagIndex.get(key)!.push(node.memory.id)
    }
  }

  // Só compara pares que compartilham pelo menos uma tag
  let inferredCount = 0
  const compared = new Set<string>()
  outer: for (const node of nodes) {
    if (inferredCount >= MAX_INFERRED_EDGES) break
    const candidates = new Set<string>()
    for (const tag of node.memory.tags) {
      const key = normalizeText(tag)
      for (const id of tagIndex.get(key) ?? []) {
        if (id !== node.memory.id) candidates.add(id)
      }
    }
    for (const candId of candidates) {
      if (inferredCount >= MAX_INFERRED_EDGES) break
      const pairKey = [node.memory.id, candId].sort().join(":")
      if (seen.has(pairKey) || compared.has(pairKey)) continue
      compared.add(pairKey)
      const b = present.get(candId)?.memory
      if (!b || b.tags.length === 0) continue
      if (jaccard(node.memory.tags, b.tags) >= INFERRED_JACCARD) {
        seen.add(pairKey)
        edges.push({ from: node.memory.id, to: candId, inferred: true, hits: 0 })
        inferredCount++
      }
    }
  }

  return { nodes, edges }
}

interface Transform {
  x: number
  y: number
  k: number
}

export function MemoryGraph({ pool, allById, query, selectedId, onSelect, projectDirectory }: {
  /** Memórias visíveis (filtro de modo/projeto — a busca só destaca) */
  pool: Memory[]
  allById: Map<string, Memory>
  query: string
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Pasta do projeto em foco — arquivos soltos no grafo viram memórias dele */
  projectDirectory?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 })
  const [linkSource, setLinkSource] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const drag = useRef<{ startX: number; startY: number; ox: number; oy: number; moved: boolean } | null>(null)

  const { nodes, edges } = useMemo(() => layoutGraph(pool), [pool])
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.memory.id, n])), [nodes])

  const queryTokens = normalizeText(query).split(" ").filter(Boolean)
  const matchesQuery = useCallback(
    (memory: Memory) => {
      if (queryTokens.length === 0) return true
      const haystack = normalizeText(`${memory.text} ${memory.tags.join(" ")}`)
      return queryTokens.every((t) => haystack.includes(t))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tokens derivam de query
    [query],
  )

  /** Reenquadra o conteúdo no container. */
  const fitView = useCallback(() => {
    const el = containerRef.current
    if (!el || nodes.length === 0) return
    const xs = nodes.map((n) => n.x)
    const ys = nodes.map((n) => n.y)
    const pad = 80
    const minX = Math.min(...xs) - pad
    const maxX = Math.max(...xs) + pad
    const minY = Math.min(...ys) - pad
    const maxY = Math.max(...ys) + pad
    const w = el.clientWidth
    const h = el.clientHeight
    const k = Math.min(w / (maxX - minX), h / (maxY - minY), 1.4)
    setTransform({
      k,
      x: w / 2 - ((minX + maxX) / 2) * k,
      y: h / 2 - ((minY + maxY) / 2) * k,
    })
  }, [nodes])

  useEffect(() => {
    fitView()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só no mount e quando o nº de nodes muda
  }, [nodes.length])

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    setTransform((t) => {
      const k = Math.min(3, Math.max(0.15, t.k * Math.exp(-e.deltaY * 0.0012)))
      return { k, x: cx - ((cx - t.x) / t.k) * k, y: cy - ((cy - t.y) / t.k) * k }
    })
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    const target = e.target as Element
    target.setPointerCapture?.(e.pointerId)
    drag.current = { startX: e.clientX, startY: e.clientY, ox: transform.x, oy: transform.y, moved: false }
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    if (d.moved) setTransform((t) => ({ ...t, x: d.ox + dx, y: d.oy + dy }))
  }

  const handlePointerUp = () => {
    drag.current = null
  }

  const handleNodeClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (drag.current?.moved) return
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click em dois nodes cria a aresta (link bidirecional)
      if (!linkSource) {
        setLinkSource(id)
      } else if (linkSource !== id) {
        void memoryApi.link(linkSource, id)
        setLinkSource(null)
      } else {
        setLinkSource(null)
      }
      return
    }
    onSelect(selectedId === id ? null : id)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDropActive(false)
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.size > MAX_DROP_FILE_SIZE) continue
      const content = await file.text()
      if (content.includes("\0")) continue // binário
      const firstLine = content.split("\n").find((l) => l.trim()) ?? ""
      await memoryApi.create({
        kind: projectDirectory ? "project" : "general",
        directory: projectDirectory,
        text: `${file.name}: ${firstLine.slice(0, 120)}`,
        tags: [file.name.replace(/\.[^.]+$/, "").toLowerCase()],
        document: content,
      })
    }
  }

  const selected = selectedId ? allById.get(selectedId) : undefined
  const now = Date.now()

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={fitView}>
            <Crosshair className="size-3.5" />
            Centralizar
          </Button>
          {linkSource && (
            <span className="flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px]">
              <Link2 className="size-3" />
              Ctrl+click no destino para ligar
              <button className="ml-1 hover:underline" onClick={() => setLinkSource(null)}>cancelar</button>
            </span>
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
        <div
          ref={containerRef}
          className={cn(
            "relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-card/50",
            dropActive && "ring-2 ring-primary/60",
          )}
          onDragOver={(e) => {
            e.preventDefault()
            setDropActive(true)
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={(e) => void handleDrop(e)}
        >
          <svg
            className="size-full cursor-grab touch-none active:cursor-grabbing"
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onClick={() => {
              if (!drag.current?.moved) onSelect(null)
            }}
          >
            <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.k})`}>
              {edges.map((edge) => {
                const a = nodeById.get(edge.from)
                const b = nodeById.get(edge.to)
                if (!a || !b) return null
                return (
                  <line
                    key={`${edge.from}:${edge.to}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    strokeWidth={edge.inferred ? 1 : 1 + Math.min(edge.hits / 10, 2)}
                    strokeDasharray={edge.inferred ? "4 4" : undefined}
                    className={edge.inferred ? "stroke-muted-foreground/25" : "stroke-muted-foreground/40"}
                  />
                )
              })}
              {nodes.map((node) => {
                const { memory } = node
                const activity = lastActivity(memory)
                const recent = now - activity < RECENT_MS
                const stale = now - activity > STALE_MS
                const matched = matchesQuery(memory)
                const isSelected = memory.id === selectedId
                const isLinkSource = memory.id === linkSource
                const color = KIND_COLOR[memory.kind]
                const opacity = !matched ? 0.18 : stale ? 0.45 : 1
                return (
                  <g
                    key={memory.id}
                    transform={`translate(${node.x}, ${node.y})`}
                    opacity={opacity}
                    className="cursor-pointer"
                    onClick={(e) => handleNodeClick(e, memory.id)}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <title>
                      {`[${KIND_LABEL[memory.kind]}${memory.area ? ` · ${PROJECT_AREAS[memory.area]?.label}` : ""}] ${memory.text}\npeso ${memory.weight.toFixed(2)} · ${memory.hits} usos${stale ? "\n(sem uso há mais de 30 dias)" : ""}`}
                    </title>
                    {/* Anel de destaque: recente, selecionado ou origem do link */}
                    {!node.isRoot && (recent || isSelected || isLinkSource) && (
                      <circle
                        r={node.r + 4}
                        fill="none"
                        stroke={isLinkSource ? "var(--primary)" : color}
                        strokeWidth={isSelected || isLinkSource ? 2.5 : 1.5}
                        strokeDasharray={isLinkSource ? "3 3" : undefined}
                        opacity={isSelected || isLinkSource ? 0.9 : 0.5}
                      />
                    )}
                    {node.isRoot ? (
                      <>
                        <rect x={-80} y={-18} width={160} height={36} rx={18}
                          fill={color} fillOpacity={0.15}
                          stroke={isSelected || isLinkSource ? "var(--primary)" : color}
                          strokeWidth={isSelected || isLinkSource ? 2.5 : 2} />
                        <foreignObject x={-80} y={-18} width={160} height={36}>
                          <div className="flex h-full items-center justify-center gap-2 px-3 text-sm font-semibold text-foreground select-none">
                            <BrainCircuit className="size-5 shrink-0" />
                            <span className="truncate">{memory.projectName ?? memory.text}</span>
                          </div>
                        </foreignObject>
                      </>
                    ) : memory.area ? (
                      <>
                        <circle r={node.r} fill={color} fillOpacity={0.12} stroke={color} strokeWidth={1.2} />
                        <foreignObject x={-node.r} y={-node.r} width={node.r * 2} height={node.r * 2}>
                          <div className="flex h-full items-center justify-center text-foreground/70 select-none">
                            {(() => {
                              const Icon = ICON_MAP[AREA_ICON[memory.area!]]
                              return Icon ? <Icon className="size-[55%]" /> : null
                            })()}
                          </div>
                        </foreignObject>
                        <text y={node.r + 12} textAnchor="middle" fontSize={11} fontWeight={600}
                          className="fill-foreground select-none">
                          {nodeLabel(memory, false)}
                        </text>
                      </>
                    ) : (
                      <>
                        <circle r={node.r} fill={color} fillOpacity={0.22} stroke={color} strokeWidth={1.2} />
                        <text y={node.r + 12} textAnchor="middle" fontSize={10} fontWeight={400}
                          className="fill-foreground select-none">
                          {nodeLabel(memory, false)}
                        </text>
                      </>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>
          {dropActive && (
            <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/70 text-sm">
              <FileUp className="size-8 text-primary" />
              <span className="font-medium">Solte o arquivo para criar memória</span>
            </div>
          )}
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
