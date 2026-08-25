/**
 * Grafo de memórias — o layout vem de @shared/memory-layout (o mesmo que o
 * mobile usa), então as duas plataformas desenham exatamente as mesmas
 * posições: a raiz do projeto no centro e os ramos crescendo para todos os
 * lados, com espaço mínimo garantido entre os rótulos. É uma vista única e
 * contínua — projetos ocupam regiões distintas do canvas, sem moldura nem
 * rótulo separando um do outro; quem isola um projeto é o filtro.
 * Aqui ficam só o desenho SVG, o zoom/pan, o colapso de subárvore e as
 * interações (selecionar, ligar com Ctrl+clique, soltar arquivo).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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

/**
 * Rótulo desenhado. Traduz o nome da área e delega o resto ao helper
 * compartilhado, para o texto medido pela colisão ser o mesmo que aparece.
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
 * Retângulo realmente ocupado pelo nó no canvas: o círculo unido ao rótulo
 * centrado abaixo. Enquadrar por (x, y) apenas cortaria os rótulos das bordas.
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

/** Ícone do nó, quando a memória tem área ou categoria com ícone próprio. */
function iconNameOf(memory: Memory, isRoot: boolean): string | undefined {
  if (isRoot) return "BrainCircuit"
  if (memory.area) return AREA_ICON[memory.area]
  if (memory.category) return CATEGORY_ICON[memory.category]
  return undefined
}

interface Transform {
  x: number
  y: number
  k: number
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
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 })
  const [linkSource, setLinkSource] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const drag = useRef<{ startX: number; startY: number; ox: number; oy: number; moved: boolean } | null>(null)

  const { nodes, edges } = useMemo(
    // labelOf entra na simulação: é a largura do texto TRADUZIDO que define o
    // espaço mínimo, senão as áreas colidiriam em idiomas mais verbosos.
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
                // Todas as arestas são retas — num grafo que cresce em todas as
                // direções, curva só embaralha. O que separa os tipos é o traço.
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
                    {/* Círculo + rótulo centrado abaixo (estilo Obsidian). O
                        deslocamento vertical do texto vem de LABEL_OFFSET, o
                        mesmo valor que a colisão do layout reserva. */}
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
                    {/* Expand / Collapse toggle — só no hover do nó */}
                    {node.childCount > 0 && (
                      <g
                        className="cursor-pointer opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={(e) => toggleCollapse(e, memory.id)}
                        onPointerDown={(e) => e.stopPropagation()}
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

    </div>
  )
}
