/**
 * Memory graph — the layout comes from @shared/memory-layout (the same one the
 * mobile app uses), so both platforms draw exactly the same
 * positions: the project root in the center and the branches growing to all
 * sides, with a minimum space guaranteed between the labels. It is a single and
 * continuous view — projects occupy distinct regions of the canvas, with no frame and no
 * label separating one from the other; what isolates a project is the filter.
 * Here only the SVG drawing, the zoom/pan, the subtree collapse and the
 * interactions live (select, link with Ctrl+click, drop file).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { BookText, BrainCircuit, Briefcase, Crosshair, Database, Eye, EyeOff, FileUp, Gauge, GraduationCap, Layers, Link2, Package, Palette, Plus, Server, Shield, SlidersHorizontal, Terminal, TestTube, ZoomIn, ZoomOut } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { TFunction } from "i18next"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Memory } from "@shared/memory"
import { normalizeText, PROJECT_AREAS } from "@shared/memory"
import { LABEL_HEIGHT, LABEL_OFFSET, layoutMemoryGraph, nodeLabelText } from "@shared/memory-layout"
import type { LayoutNode } from "@shared/memory-layout"
import { memoryApi } from "@/src/lib/ipc"
import { AREA_ICON, CATEGORY_ICON, KIND_COLOR, KIND_LABEL, lastActivity } from "./meta"
import { useCanvasViewport } from "./use-graph-viewport"
import type { CanvasViewport } from "./use-graph-viewport"
import { Hint } from "@/components/ui/hint"

const ICON_MAP: Record<string, LucideIcon> = {
  BrainCircuit, Briefcase, Palette, Layers, SlidersHorizontal, Server, Shield, Terminal,
  Database, TestTube, Gauge, Package, BookText, GraduationCap,
}

const RECENT_MS = 7 * 24 * 60 * 60 * 1000
const STALE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_DROP_FILE_SIZE = 512 * 1024
const ZOOM_FACTOR = 1.3
const ZOOM_MIN = 0.04
const ZOOM_MAX = 3
const MINIMAP_W = 160
const MINIMAP_H = 120

/**
 * Drawn label. It translates the area name and delegates the rest to the
 * shared helper, so the text measured by the collision is the same one that appears.
 */
function nodeLabel(memory: Memory, isRoot: boolean, t: TFunction): string {
  if (!isRoot && memory.area) {
    return t(`memories.areas.${memory.area}`, {
      defaultValue: PROJECT_AREAS[memory.area]?.label ?? memory.text,
    })
  }
  return nodeLabelText(memory, isRoot)
}

/**
 * Rectangle actually occupied by the node on the canvas: the circle joined to the label
 * centered below it. Framing only by (x, y) would cut the labels at the edges.
 */
function extentOf(node: LayoutNode) {
  const halfW = Math.max(node.r, node.labelHalfWidth)
  return {
    minX: node.x - halfW,
    maxX: node.x + halfW,
    minY: node.y - node.r,
    maxY: node.y + node.r + LABEL_OFFSET + LABEL_HEIGHT,
  }
}

/** Node icon, when the memory has an area or category with its own icon. */
function iconNameOf(memory: Memory, isRoot: boolean): string | undefined {
  if (isRoot) return "BrainCircuit"
  if (memory.area) return AREA_ICON[memory.area]
  if (memory.category) return CATEGORY_ICON[memory.category]
  return undefined
}

/**
 * Zoom label. It subscribes to the viewport instead of receiving the transform by prop:
 * that way only it redraws while the canvas moves, and not the whole scene.
 */
function ZoomLabel({ viewport }: { viewport: CanvasViewport }) {
  const k = useSyncExternalStore(viewport.subscribe, () => viewport.getTransform().k)
  return (
    <span className="min-w-[3rem] text-center text-[11px] tabular-nums text-muted-foreground">
      {Math.round(k * 100)}%
    </span>
  )
}

/** Rectangle of what is visible, in the minimap. It subscribes for the same reason. */
function MinimapViewport({ viewport, bounds, containerRef }: {
  viewport: CanvasViewport
  bounds: { minX: number; minY: number; width: number; height: number }
  containerRef: React.RefObject<HTMLDivElement>
}) {
  const t = useSyncExternalStore(viewport.subscribe, viewport.getTransform)
  const el = containerRef.current
  if (!el) return null
  const vx = -t.x / t.k
  const vy = -t.y / t.k
  return (
    <rect
      x={((vx - bounds.minX) / bounds.width) * MINIMAP_W}
      y={((vy - bounds.minY) / bounds.height) * MINIMAP_H}
      width={(el.clientWidth / t.k / bounds.width) * MINIMAP_W}
      height={(el.clientHeight / t.k / bounds.height) * MINIMAP_H}
      fill="none"
      stroke="var(--primary)"
      strokeWidth={1.2}
      rx={2}
      className="pointer-events-none"
    />
  )
}

export function MemoryGraph({ pool, query, selectedId, onSelect, projectDirectory }: {
  pool: Memory[]
  query: string
  selectedId: string | null
  onSelect: (id: string | null) => void
  projectDirectory?: string
}) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  // Pan/zoom live outside the React state: during the gesture the transform goes
  // straight to the DOM and the scene is not reconciled. See use-graph-viewport.
  const viewport = useCanvasViewport({ minZoom: ZOOM_MIN, maxZoom: ZOOM_MAX })
  const [linkSource, setLinkSource] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())

  const { nodes, edges } = useMemo(
    // labelOf enters the simulation: it is the width of the TRANSLATED text that defines the
    // minimum space, otherwise the areas would collide in more verbose languages.
    () =>
      layoutMemoryGraph(pool, {
        collapsedIds,
        inferEdges: true,
        labelOf: (memory, isRoot) => nodeLabel(memory, isRoot, t),
      }),
    [pool, collapsedIds, t],
  )
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.memory.id, n])), [nodes])

  // Bounding box of all nodes for minimap
  const bounds = useMemo(() => {
    if (nodes.length === 0) return { minX: -200, minY: -200, maxX: 200, maxY: 200, width: 400, height: 400 }
    const boxes = nodes.map(extentOf)
    const minX = Math.min(...boxes.map((b) => b.minX)) - 120
    const maxX = Math.max(...boxes.map((b) => b.maxX)) + 120
    const minY = Math.min(...boxes.map((b) => b.minY)) - 120
    const maxY = Math.max(...boxes.map((b) => b.maxY)) + 120
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
  }, [nodes])

  const queryTokens = useMemo(() => normalizeText(query).split(" ").filter(Boolean), [query])
  const matchesQuery = useCallback(
    (memory: Memory) => {
      if (queryTokens.length === 0) return true
      const haystack = normalizeText(`${memory.text} ${memory.tags.join(" ")}`)
      return queryTokens.every((t) => haystack.includes(t))
    },
    [queryTokens],
  )

  const fitView = useCallback((animate = true) => {
    const el = containerRef.current
    if (!el || nodes.length === 0) return
    const boxes = nodes.map(extentOf)
    const pad = 80
    const minX = Math.min(...boxes.map((b) => b.minX)) - pad
    const maxX = Math.max(...boxes.map((b) => b.maxX)) + pad
    const minY = Math.min(...boxes.map((b) => b.minY)) - pad
    const maxY = Math.max(...boxes.map((b) => b.maxY)) + pad
    const w = el.clientWidth
    const h = el.clientHeight
    const k = Math.max(
      ZOOM_MIN,
      Math.min(w / (maxX - minX), h / (maxY - minY), 1.4),
    )
    viewport.setViewport({
      k,
      x: w / 2 - ((minX + maxX) / 2) * k,
      y: h / 2 - ((minY + maxY) / 2) * k,
    }, animate)
  }, [nodes, viewport])

  // The first framing is instant; the following ones (the graph changed
  // size) slide, which is less abrupt than the content jumping.
  const framed = useRef(false)
  useEffect(() => {
    fitView(framed.current)
    framed.current = true
    // Re-frames when the graph CHANGES SIZE. fitView depends on `nodes`,
    // which changes identity on every recalculation — as a dep, it would throw away the
    // user's pan/zoom on every update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length])

  const zoomIn = useCallback(() => viewport.zoomBy(ZOOM_FACTOR), [viewport])
  const zoomOut = useCallback(() => viewport.zoomBy(1 / ZOOM_FACTOR), [viewport])

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

  const toggleCollapse = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (viewport.wasDragged()) return
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleNodeClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    // A click that is only the end of a drag selects nothing.
    if (viewport.wasDragged()) return
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
    const svgRect = e.currentTarget.getBoundingClientRect()
    // Minimap point → graph coordinate → center of the view.
    const gx = bounds.minX + ((e.clientX - svgRect.left) / MINIMAP_W) * bounds.width
    const gy = bounds.minY + ((e.clientY - svgRect.top) / MINIMAP_H) * bounds.height
    const { k } = viewport.getTransform()
    viewport.setViewport({
      k,
      x: el.clientWidth / 2 - gx * k,
      y: el.clientHeight / 2 - gy * k,
    }, true)
  }

  const now = Date.now()

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Hint label={t("memories.zoomIn")}>
            <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={zoomIn} >
              <ZoomIn className="size-3.5" />
            </Button>
          </Hint>
          <ZoomLabel viewport={viewport} />
          <Hint label={t("memories.zoomOut")}>
            <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={zoomOut} >
              <ZoomOut className="size-3.5" />
            </Button>
          </Hint>
          <Hint label={t("memories.centerTitle")}>
            <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => fitView()} >
       
               <Crosshair className="size-3.5" />
            {t("memories.center")}
          </Button>
          </Hint>
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
            ref={viewport.surfaceRef}
            className="size-full cursor-grab touch-none select-none active:cursor-grabbing"
            onPointerDown={viewport.onPointerDown}
            onClick={() => { if (!viewport.wasDragged()) onSelect(null) }}
          >
            {/* The transform is written straight into this <g> by the viewport — no
                CSS transition here: it restarted on every wheel event and was
                what made the zoom look stuck. */}
            <g ref={viewport.sceneRef}>
              {edges.map((edge) => {
                const a = nodeById.get(edge.from)
                const b = nodeById.get(edge.to)
                if (!a || !b) return null
                // All the edges are straight — in a graph that grows in all
                // directions, a curve only muddles. What separates the types is the stroke.
                return (
                  <line
                    key={`${edge.from}:${edge.to}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    strokeWidth={edge.kind === "tree" ? 1 + Math.min(edge.hits / 14, 1.4) : 1}
                    strokeDasharray={
                      edge.kind === "tree" ? undefined : edge.kind === "inferred" ? "3 5" : "6 4"
                    }
                    className={
                      edge.kind === "tree"
                        ? "stroke-muted-foreground/45"
                        : edge.kind === "inferred"
                          ? "stroke-muted-foreground/20"
                          : "stroke-primary/30"
                    }
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
                    {/* Circle + label centered below (Obsidian style). The
                        vertical offset of the text comes from LABEL_OFFSET, the
                        same value the layout collision reserves. */}
                    <circle
                      r={node.r}
                      fill={color}
                      fillOpacity={node.isRoot ? 0.3 : memory.area ? 0.16 : 0.24}
                      stroke={isSelected || isLinkSource ? "var(--primary)" : color}
                      strokeWidth={isSelected || isLinkSource ? 2.5 : node.isRoot ? 2 : 1.2}
                    />
                    {(() => {
                      const iconName = iconNameOf(memory, node.isRoot)
                      const Icon = iconName ? ICON_MAP[iconName] : undefined
                      if (!Icon) return null
                      return (
                        <foreignObject x={-node.r} y={-node.r} width={node.r * 2} height={node.r * 2}>
                          <div className="flex h-full items-center justify-center text-foreground/70 select-none">
                            <Icon className="size-[55%]" />
                          </div>
                        </foreignObject>
                      )
                    })()}
                    <text
                      y={node.r + LABEL_OFFSET + 10}
                      textAnchor="middle"
                      fontSize={node.isRoot ? 13 : memory.area ? 11 : 10}
                      fontWeight={node.isRoot ? 700 : memory.area ? 600 : 400}
                      className="fill-foreground select-none"
                    >
                      {nodeLabel(memory, node.isRoot, t)}
                    </text>
                    {/* Expand / Collapse toggle — only on the hover of the node */}
                    {node.childCount > 0 && (
                      <g
                        className="cursor-pointer opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={(e) => toggleCollapse(e, memory.id)}
                      >
                        <circle
                          cx={-node.r - 10}
                          cy={0}
                          r={8}
                          fill="var(--card)"
                          stroke="var(--border)"
                          strokeWidth={1}
                        />
                        <foreignObject x={-node.r - 17} y={-7} width={14} height={14}>
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
              width={MINIMAP_W}
              height={MINIMAP_H}
              viewBox={`0 0 ${MINIMAP_W} ${MINIMAP_H}`}
              onClick={handleMinimapClick}
            >
              <rect width={MINIMAP_W} height={MINIMAP_H} rx={6} fill="var(--card)" fillOpacity={0.95} />
              {/* Node dots */}
              {nodes.map((node) => {
                const px = ((node.x - bounds.minX) / bounds.width) * MINIMAP_W
                const py = ((node.y - bounds.minY) / bounds.height) * MINIMAP_H
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
              <MinimapViewport viewport={viewport} bounds={bounds} containerRef={containerRef} />
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

    </div>
  )
}
