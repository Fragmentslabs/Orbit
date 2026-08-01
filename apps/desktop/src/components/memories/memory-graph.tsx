import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { BookText, BrainCircuit, Briefcase, Crosshair, Database, Eye, EyeOff, FileUp, Gauge, GraduationCap, Layers, Link2, Package, Palette, Plus, Server, Shield, SlidersHorizontal, Terminal, TestTube, ZoomIn, ZoomOut } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { TFunction } from "i18next"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Memory } from "@shared/memory"
import { jaccard, normalizeText, PROJECT_AREAS } from "@shared/memory"
import { memoryApi } from "@/src/lib/ipc"
import { MemoryCard } from "./memory-card"
import { AREA_ICON, CATEGORY_ICON, KIND_COLOR, KIND_LABEL, lastActivity } from "./meta"

const ICON_MAP: Record<string, LucideIcon> = {
  BrainCircuit, Briefcase, Palette, Layers, SlidersHorizontal, Server, Shield, Terminal,
  Database, TestTube, Gauge, Package, BookText, GraduationCap,
}

const LEVEL_RADIUS = 150
const CLUSTER_PAD = 90
const LOOSE_RING_PAD = 110
const RECENT_MS = 7 * 24 * 60 * 60 * 1000
const STALE_MS = 30 * 24 * 60 * 60 * 1000
const INFERRED_JACCARD = 0.5
const MAX_INFERRED_EDGES = 30
const MAX_DROP_FILE_SIZE = 512 * 1024
const ZOOM_FACTOR = 1.3
const ZOOM_MIN = 0.15
const ZOOM_MAX = 3

interface GraphNode {
  memory: Memory
  x: number
  y: number
  r: number
  isRoot: boolean
  hasChildren: boolean
  collapsed: boolean
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

function nodeLabel(memory: Memory, isRoot: boolean, t: TFunction): string {
  if (isRoot && memory.projectName) return memory.projectName
  if (memory.area) return t(`memories.areas.${memory.area}`, { defaultValue: PROJECT_AREAS[memory.area]?.label ?? memory.text })
  return memory.text.length > 34 ? `${memory.text.slice(0, 34)}…` : memory.text
}

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
      bucket.forEach((m, i) => {
        const angle = (i / bucket.length) * 2 * Math.PI
        const r = bucket.length === 1 ? 0 : 40
        nodes.push({
          memory: m,
          x: Math.cos(angle) * r,
          y: Math.sin(angle) * r,
          r: nodeRadius(m, m.id === root.id),
          isRoot: m.id === root.id,
          hasChildren: false,
          collapsed: false,
        })
      })
      continue
    }
    bucket.forEach((m, i) => {
      const angle = -Math.PI / 2 + (i / bucket.length) * 2 * Math.PI + depth * 0.35
      nodes.push({
        memory: m,
        x: Math.cos(angle) * depth * LEVEL_RADIUS,
        y: Math.sin(angle) * depth * LEVEL_RADIUS,
        r: nodeRadius(m, false),
        isRoot: false,
        hasChildren: false,
        collapsed: false,
      })
    })
  }

  const maxLevel = Math.max(0, ...byLevel.keys())
  return { nodes, radius: maxLevel * LEVEL_RADIUS + 60 }
}

function layoutGraph(pool: Memory[], collapsedIds: Set<string>): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const comps = components(pool)

  const clusters = comps.filter((c) => c.length > 1).sort((a, b) => b.length - a.length)
  const loose = comps.filter((c) => c.length === 1).map((c) => c[0])

  const nodes: GraphNode[] = []

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
        hasChildren: false,
        collapsed: false,
      })
    })
  }

  // Compute hasChildren
  // Se não tem relationTypes, assume que todos os relatedIds são filhos (compatibilidade com dados antigos)
  const poolSet = new Set(pool.map((m) => m.id))
  for (const node of nodes) {
    const rt = node.memory.relationTypes
    node.hasChildren = node.memory.relatedIds.some((relId) => {
      if (!poolSet.has(relId)) return false
      if (!rt) return true // sem relationTypes → tudo é filho em potencial
      return rt[relId] === "parent"
    })
  }

  // Filter collapsed nodes (and their tree descendants) from display
  // Só desce na árvore seguindo relationTypes "parent" — não varre o grafo todo.
  let visibleNodes: GraphNode[]
  if (collapsedIds.size > 0) {
    const hidden = new Set<string>()
    const byId = new Map(nodes.map((n) => [n.memory.id, n]))
    for (const cid of collapsedIds) {
      // A memória em si fica visível; só os descendentes são ocultados
      const queue: string[] = []
      // Se não tem relationTypes, trata relatedIds como filhos diretos (1 nível, compatibilidade)
      // Se tem, só desce onde relationTypes[rel] === "parent"
      const startNode = byId.get(cid)
      if (!startNode) continue
      const startRt = startNode.memory.relationTypes
      for (const rel of startNode.memory.relatedIds) {
        if (!byId.has(rel) || hidden.has(rel)) continue
        if (!startRt) {
          // Sem relationTypes → filhos diretos, 1 nível apenas
          hidden.add(rel)
        } else if (startRt[rel] === "parent") {
          hidden.add(rel)
          queue.push(rel) // desce recursivamente
        }
      }
      // BFS recursiva apenas para nós com relationTypes explícitos
      while (queue.length) {
        const id = queue.pop()!
        const node = byId.get(id)
        if (!node) continue
        for (const rel of node.memory.relatedIds) {
          if (node.memory.relationTypes?.[rel] !== "parent") continue
          if (!byId.has(rel) || hidden.has(rel)) continue
          hidden.add(rel)
          queue.push(rel)
        }
      }
    }
    visibleNodes = nodes.filter((n) => !hidden.has(n.memory.id))
  } else {
    visibleNodes = nodes
  }

  // Mark collapsed state on visible nodes
  const collapsedSet = new Set(collapsedIds)
  for (const node of visibleNodes) {
    if (collapsedSet.has(node.memory.id)) {
      node.collapsed = true
    }
  }

  // Edges — only between visible nodes
  const present = new Map(visibleNodes.map((n) => [n.memory.id, n]))
  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  for (const node of visibleNodes) {
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

  // Inferred edges
  const tagIndex = new Map<string, string[]>()
  for (const node of visibleNodes) {
    for (const tag of node.memory.tags) {
      const key = normalizeText(tag)
      if (!tagIndex.has(key)) tagIndex.set(key, [])
      tagIndex.get(key)!.push(node.memory.id)
    }
  }

  let inferredCount = 0
  const compared = new Set<string>()
  for (const node of visibleNodes) {
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

  return { nodes: visibleNodes, edges }
}

interface Transform {
  x: number
  y: number
  k: number
}

export function MemoryGraph({ pool, allById, query, selectedId, onSelect, projectDirectory }: {
  pool: Memory[]
  allById: Map<string, Memory>
  query: string
  selectedId: string | null
  onSelect: (id: string | null) => void
  projectDirectory?: string
}) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 })
  const [linkSource, setLinkSource] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const drag = useRef<{ startX: number; startY: number; ox: number; oy: number; moved: boolean } | null>(null)

  const { nodes, edges } = useMemo(() => layoutGraph(pool, collapsedIds), [pool, collapsedIds])
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.memory.id, n])), [nodes])

  // Bounding box of all nodes for minimap
  const bounds = useMemo(() => {
    if (nodes.length === 0) return { minX: -200, minY: -200, maxX: 200, maxY: 200, width: 400, height: 400 }
    const xs = nodes.map((n) => n.x)
    const ys = nodes.map((n) => n.y)
    const minX = Math.min(...xs) - 120
    const maxX = Math.max(...xs) + 120
    const minY = Math.min(...ys) - 120
    const maxY = Math.max(...ys) + 120
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
  }, [nodes])

  const queryTokens = normalizeText(query).split(" ").filter(Boolean)
  const matchesQuery = useCallback(
    (memory: Memory) => {
      if (queryTokens.length === 0) return true
      const haystack = normalizeText(`${memory.text} ${memory.tags.join(" ")}`)
      return queryTokens.every((t) => haystack.includes(t))
    },
    [query],
  )

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
  }, [nodes.length])

  const zoomTo = useCallback((newK: number, centerX?: number, centerY?: number) => {
    const el = containerRef.current
    if (!el) return
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newK))
    if (centerX != null && centerY != null) {
      setTransform((t) => ({
        k,
        x: centerX - ((centerX - t.x) / t.k) * k,
        y: centerY - ((centerY - t.y) / t.k) * k,
      }))
    } else {
      setTransform((t) => {
        const rect = el.getBoundingClientRect()
        const cx = rect.width / 2
        const cy = rect.height / 2
        return {
          k,
          x: cx - ((cx - t.x) / t.k) * k,
          y: cy - ((cy - t.y) / t.k) * k,
        }
      })
    }
  }, [])

  const zoomIn = useCallback(() => zoomTo(transform.k * ZOOM_FACTOR), [zoomTo, transform.k])
  const zoomOut = useCallback(() => zoomTo(transform.k / ZOOM_FACTOR), [zoomTo, transform.k])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = containerRef.current
      if (!el || !el.contains(document.activeElement) && document.activeElement !== el) return
      if (!(e.ctrlKey || e.metaKey)) return
      switch (e.key) {
        case "=":
        case "+":
          e.preventDefault()
          zoomIn()
          break
        case "-":
          e.preventDefault()
          zoomOut()
          break
        case "0":
          e.preventDefault()
          fitView()
          break
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [zoomIn, zoomOut, fitView])

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    setTransform((t) => {
      const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, t.k * Math.exp(-e.deltaY * 0.0012)))
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

  const toggleCollapse = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleNodeClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (drag.current?.moved) return
    if (e.ctrlKey || e.metaKey) {
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
      if (content.includes("\0")) continue
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

  const handleMinimapClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const el = containerRef.current
    if (!el) return
    const svg = e.currentTarget
    const svgRect = svg.getBoundingClientRect()
    const px = e.clientX - svgRect.left
    const py = e.clientY - svgRect.top
    const mmW = 160
    const mmH = 120
    // Map to graph bounds
    const gx = bounds.minX + (px / mmW) * bounds.width
    const gy = bounds.minY + (py / mmH) * bounds.height
    // Center view on this point
    const cx = el.clientWidth / 2
    const cy = el.clientHeight / 2
    setTransform((t) => ({
      k: t.k,
      x: cx - gx * t.k,
      y: cy - gy * t.k,
    }))
  }

  const selected = selectedId ? allById.get(selectedId) : undefined
  const now = Date.now()

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={zoomIn} title={t("memories.zoomIn")}>
            <ZoomIn className="size-3.5" />
          </Button>
          <span className="min-w-[3rem] text-center text-[11px] tabular-nums text-muted-foreground">
            {Math.round(transform.k * 100)}%
          </span>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={zoomOut} title={t("memories.zoomOut")}>
            <ZoomOut className="size-3.5" />
          </Button>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={fitView} title={t("memories.centerTitle")}>
            <Crosshair className="size-3.5" />
            {t("memories.center")}
          </Button>
          {collapsedIds.size > 0 && (
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setCollapsedIds(new Set())}>
              <Plus className="size-3.5" />
              {t("memories.expandAll")}
            </Button>
          )}
          {linkSource && (
            <span className="flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px]">
              <Link2 className="size-3" />
              {t("memories.linkPrompt")}
              <button className="ml-1 hover:underline" onClick={() => setLinkSource(null)}>{t("memories.linkCancel")}</button>
            </span>
          )}
          <span className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
            {(Object.keys(KIND_COLOR) as Array<keyof typeof KIND_COLOR>).map((kind) => (
              <span key={kind} className="flex items-center gap-1">
                <span className="size-2 rounded-full" style={{ backgroundColor: KIND_COLOR[kind] }} />
                {t(`memories.kinds.${kind}`, { defaultValue: KIND_LABEL[kind] })}
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
          onDragOver={(e) => { e.preventDefault(); setDropActive(true) }}
          onDragLeave={() => setDropActive(false)}
          onDrop={(e) => void handleDrop(e)}
        >
          <svg
            className="size-full cursor-grab touch-none active:cursor-grabbing"
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onClick={() => { if (!drag.current?.moved) onSelect(null) }}
          >
            <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.k})`}
               style={{ transition: 'transform 0.12s ease-out' }}>
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
                    className="group cursor-pointer"
                    onClick={(e) => handleNodeClick(e, memory.id)}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <title>
                      {`[${t(`memories.kinds.${memory.kind}`, { defaultValue: KIND_LABEL[memory.kind] })}${memory.area ? ` · ${t(`memories.areas.${memory.area}`, { defaultValue: PROJECT_AREAS[memory.area]?.label })}` : ""}] ${memory.text}\n${t("memories.tooltipWeight", { weight: memory.weight.toFixed(2) })} · ${t("memories.uses", { count: memory.hits })}${stale ? `\n${t("memories.tooltipStale")}` : ""}${node.collapsed ? `\n${t("memories.tooltipCollapsed")}` : ""}`}
                    </title>
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
                          {nodeLabel(memory, false, t)}
                        </text>
                      </>
                    ) : memory.category && CATEGORY_ICON[memory.category] ? (
                      <>
                        <circle r={node.r} fill={color} fillOpacity={0.12} stroke={color} strokeWidth={1.2} />
                        <foreignObject x={-node.r} y={-node.r} width={node.r * 2} height={node.r * 2}>
                          <div className="flex h-full items-center justify-center text-foreground/70 select-none">
                            {(() => {
                              const Icon = ICON_MAP[CATEGORY_ICON[memory.category!]!]
                              return Icon ? <Icon className="size-[55%]" /> : null
                            })()}
                          </div>
                        </foreignObject>
                        <text y={node.r + 12} textAnchor="middle" fontSize={11} fontWeight={600}
                          className="fill-foreground select-none">
                          {nodeLabel(memory, false, t)}
                        </text>
                      </>
                    ) : (
                      <>
                        <circle r={node.r} fill={color} fillOpacity={0.22} stroke={color} strokeWidth={1.2} />
                        <text y={node.r + 12} textAnchor="middle" fontSize={10} fontWeight={400}
                          className="fill-foreground select-none">
                          {nodeLabel(memory, false, t)}
                        </text>
                      </>
                    )}
                    {/* Expand / Collapse toggle — só no hover do nó */}
                    {node.hasChildren && (
                      <g
                        className="cursor-pointer opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={(e) => toggleCollapse(e, memory.id)}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <circle
                          cx={node.r + 10}
                          cy={-node.r - 4}
                          r={8}
                          fill="var(--card)"
                          stroke="var(--border)"
                          strokeWidth={1}
                        />
                        <foreignObject x={node.r + 4} y={-node.r - 11} width={14} height={14}>
                          <div className="flex h-full items-center justify-center select-none">
                            {node.collapsed ? (
                              <EyeOff className="size-3 text-muted-foreground" />
                            ) : (
                              <Eye className="size-3 text-muted-foreground" />
                            )}
                          </div>
                        </foreignObject>
                      </g>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>

          {/* Mini-map */}
          {nodes.length > 0 && (
            <svg
              className="absolute bottom-2 right-2 z-20 cursor-pointer rounded-lg border bg-card/90 shadow-sm"
              width={160}
              height={120}
              viewBox="0 0 160 120"
              onClick={handleMinimapClick}
            >
              <rect width={160} height={120} rx={6} fill="var(--card)" fillOpacity={0.95} />
              {/* Node dots */}
              {nodes.map((node) => {
                const px = ((node.x - bounds.minX) / bounds.width) * 160
                const py = ((node.y - bounds.minY) / bounds.height) * 120
                return (
                  <circle
                    key={node.memory.id}
                    cx={px}
                    cy={py}
                    r={Math.max(2, node.r * 0.12)}
                    fill={KIND_COLOR[node.memory.kind]}
                    opacity={0.7}
                  />
                )
              })}
              {/* Viewport indicator */}
              {(() => {
                const el = containerRef.current
                if (!el) return null
                const vw = el.clientWidth / transform.k
                const vh = el.clientHeight / transform.k
                const vx = (-transform.x / transform.k)
                const vy = (-transform.y / transform.k)
                const mmPx = (vx - bounds.minX) / bounds.width * 160
                const mmPy = (vy - bounds.minY) / bounds.height * 120
                const mmPw = vw / bounds.width * 160
                const mmPh = vh / bounds.height * 120
                return (
                  <rect
                    x={mmPx}
                    y={mmPy}
                    width={mmPw}
                    height={mmPh}
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth={1.2}
                    rx={2}
                    className="pointer-events-none"
                  />
                )
              })()}
            </svg>
          )}

          {dropActive && (
            <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/70 text-sm">
              <FileUp className="size-8 text-primary" />
              <span className="font-medium">{t("memories.dropFile")}</span>
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
