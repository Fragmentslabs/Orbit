/**
 * Grafo de memórias — porte do memory-graph do desktop: projeto no centro,
 * áreas ao redor, memórias ligadas como filhos e avulsas na periferia.
 * Mesmo layout radial (BFS em anéis, clusters em grade); zoom/pan viram
 * pinch/arrastar, e o node selecionado abre o card num overlay inferior.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Svg, { G, Line, Circle, Rect, Text as SvgText } from 'react-native-svg'
import { Crosshair, X } from 'lucide-react-native'
import type { Memory } from '@orbit/shared'
import { jaccard, normalizeText, PROJECT_AREAS } from '@orbit/shared'
import { KIND_COLOR, KIND_LABEL, lastActivity } from './meta'
import { MemoryCard } from './MemoryCard'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const LEVEL_RADIUS = 150
const CLUSTER_PAD = 90
const LOOSE_RING_PAD = 110
const RECENT_MS = 7 * 24 * 60 * 60 * 1000
const STALE_MS = 30 * 24 * 60 * 60 * 1000
const INFERRED_JACCARD = 0.5
const MAX_INFERRED_EDGES = 30

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
    cluster.find((m) => m.area === 'overview') ??
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
      })
    })
  }

  const present = new Map(nodes.map((n) => [n.memory.id, n]))
  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    for (const rel of node.memory.relatedIds) {
      if (!present.has(rel)) continue
      const key = [node.memory.id, rel].sort().join(':')
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

  const tagIndex = new Map<string, string[]>()
  for (const node of nodes) {
    for (const tag of node.memory.tags) {
      const key = normalizeText(tag)
      if (!tagIndex.has(key)) tagIndex.set(key, [])
      tagIndex.get(key)!.push(node.memory.id)
    }
  }

  let inferredCount = 0
  const compared = new Set<string>()
  for (const node of nodes) {
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
      const pairKey = [node.memory.id, candId].sort().join(':')
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

export function MemoryGraph({ pool, allById, query, selectedId, onSelect }: {
  /** Memórias visíveis (filtro de modo/projeto — a busca só destaca) */
  pool: Memory[]
  allById: Map<string, Memory>
  query: string
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 })
  const [size, setSize] = useState({ w: 0, h: 0 })
  const gestureBase = useRef<Transform>({ x: 0, y: 0, k: 1 })
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const { nodes, edges } = useMemo(() => layoutGraph(pool), [pool])
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.memory.id, n])), [nodes])

  const queryTokens = normalizeText(query).split(' ').filter(Boolean)
  const matchesQuery = useCallback(
    (memory: Memory) => {
      if (queryTokens.length === 0) return true
      const haystack = normalizeText(`${memory.text} ${memory.tags.join(' ')}`)
      return queryTokens.every((t) => haystack.includes(t))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tokens derivam de query
    [query],
  )

  /** Reenquadra o conteúdo no container. */
  const fitView = useCallback(
    (w = size.w, h = size.h) => {
      if (!w || !h || nodes.length === 0) return
      const xs = nodes.map((n) => n.x)
      const ys = nodes.map((n) => n.y)
      const pad = 80
      const minX = Math.min(...xs) - pad
      const maxX = Math.max(...xs) + pad
      const minY = Math.min(...ys) - pad
      const maxY = Math.max(...ys) + pad
      const k = Math.min(w / (maxX - minX), h / (maxY - minY), 1.4)
      setTransform({
        k,
        x: w / 2 - ((minX + maxX) / 2) * k,
        y: h / 2 - ((minY + maxY) / 2) * k,
      })
    },
    [nodes, size],
  )

  // Pan (1 dedo) + pinch (2 dedos) — estado simples em JS; o grafo é pequeno
  const panGesture = Gesture.Pan()
    .runOnJS(true)
    .onStart(() => {
      gestureBase.current = transform
    })
    .onUpdate((e) => {
      setTransform({
        ...gestureBase.current,
        x: gestureBase.current.x + e.translationX,
        y: gestureBase.current.y + e.translationY,
      })
    })

  const pinchGesture = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => {
      gestureBase.current = transform
    })
    .onUpdate((e) => {
      const base = gestureBase.current
      const k = Math.min(3, Math.max(0.15, base.k * e.scale))
      const fx = e.focalX
      const fy = e.focalY
      setTransform({
        k,
        x: fx - ((fx - base.x) / base.k) * k,
        y: fy - ((fy - base.y) / base.k) * k,
      })
    })

  const composed = Gesture.Simultaneous(panGesture, pinchGesture)

  const selected = selectedId ? allById.get(selectedId) : undefined
  const now = Date.now()

  return (
    <View style={{ flex: 1, gap: 8 }}>
      {/* Toolbar: centralizar + legenda */}
      <View style={s.toolbar}>
        <Pressable onPress={() => fitView()} style={[s.centerBtn, { borderColor: tokens.border }]}>
          <Crosshair size={13} color={tokens.foreground} />
          <Text style={[s.centerBtnText, { color: tokens.foreground }]}>Centralizar</Text>
        </Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.legend}>
          {(Object.keys(KIND_COLOR) as Array<keyof typeof KIND_COLOR>).map((kind) => (
            <View key={kind} style={s.legendItem}>
              <View style={[s.legendDot, { backgroundColor: KIND_COLOR[kind] }]} />
              <Text style={[s.legendText, { color: tokens.mutedForeground }]}>{KIND_LABEL[kind]}</Text>
            </View>
          ))}
        </ScrollView>
      </View>

      {/* Canvas */}
      <View
        style={[s.canvas, { borderColor: tokens.border, backgroundColor: tokens.card + '80' }]}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout
          const first = size.w === 0
          setSize({ w: width, h: height })
          if (first) fitView(width, height)
        }}
      >
        <GestureDetector gesture={composed}>
          <Svg width="100%" height="100%">
            <G translateX={transform.x} translateY={transform.y} scale={transform.k}>
              {edges.map((edge) => {
                const a = nodeById.get(edge.from)
                const b = nodeById.get(edge.to)
                if (!a || !b) return null
                return (
                  <Line
                    key={`${edge.from}:${edge.to}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={edge.inferred ? 'rgba(138,142,153,0.25)' : 'rgba(138,142,153,0.4)'}
                    strokeWidth={edge.inferred ? 1 : 1 + Math.min(edge.hits / 10, 2)}
                    strokeDasharray={edge.inferred ? '4 4' : undefined}
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
                const color = KIND_COLOR[memory.kind]
                const opacity = !matched ? 0.18 : stale ? 0.45 : 1
                const label = nodeLabel(memory, node.isRoot)
                return (
                  <G
                    key={memory.id}
                    translateX={node.x}
                    translateY={node.y}
                    opacity={opacity}
                    onPress={() => onSelect(isSelected ? null : memory.id)}
                  >
                    {!node.isRoot && (recent || isSelected) && (
                      <Circle
                        r={node.r + 4}
                        fill="none"
                        stroke={color}
                        strokeWidth={isSelected ? 2.5 : 1.5}
                        opacity={isSelected ? 0.9 : 0.5}
                      />
                    )}
                    {node.isRoot ? (
                      <>
                        <Rect
                          x={-80}
                          y={-18}
                          width={160}
                          height={36}
                          rx={18}
                          fill={color}
                          fillOpacity={0.15}
                          stroke={color}
                          strokeWidth={isSelected ? 2.5 : 2}
                        />
                        <SvgText
                          y={4}
                          textAnchor="middle"
                          fontSize={13}
                          fontWeight="600"
                          fill={tokens.foreground}
                        >
                          {label.length > 20 ? `${label.slice(0, 20)}…` : label}
                        </SvgText>
                      </>
                    ) : (
                      <>
                        <Circle
                          r={node.r}
                          fill={color}
                          fillOpacity={memory.area ? 0.12 : 0.22}
                          stroke={color}
                          strokeWidth={1.2}
                        />
                        <SvgText
                          y={node.r + 12}
                          textAnchor="middle"
                          fontSize={memory.area ? 11 : 10}
                          fontWeight={memory.area ? '600' : '400'}
                          fill={tokens.foreground}
                        >
                          {label}
                        </SvgText>
                      </>
                    )}
                  </G>
                )
              })}
            </G>
          </Svg>
        </GestureDetector>

        {/* Card da memória selecionada — overlay inferior */}
        {selected && (
          <View style={s.selectedOverlay}>
            <Pressable onPress={() => onSelect(null)} style={[s.selectedClose, { backgroundColor: tokens.muted }]}>
              <X size={16} color={tokens.mutedForeground} />
            </Pressable>
            <ScrollView style={{ maxHeight: 260 }}>
              <MemoryCard
                memory={selected}
                related={selected.relatedIds
                  .map((id) => allById.get(id))
                  .filter((m): m is Memory => m != null)}
                onSelectRelated={onSelect}
              />
            </ScrollView>
          </View>
        )}
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  centerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  centerBtnText: { fontSize: 12, fontWeight: '500' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11 },

  canvas: { flex: 1, borderRadius: 14, borderWidth: 1, overflow: 'hidden' },

  selectedOverlay: { position: 'absolute', left: 8, right: 8, bottom: 8 },
  selectedClose: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 10,
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
