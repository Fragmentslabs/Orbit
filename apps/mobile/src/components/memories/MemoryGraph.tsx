/**
 * Grafo de memórias — porte do memory-graph do desktop. O layout vem de
 * @orbit/shared (layoutMemoryGraph), então as duas plataformas desenham
 * exatamente as mesmas posições: a raiz do projeto no centro e os ramos
 * crescendo para todos os lados, com espaço mínimo garantido entre os rótulos.
 * É uma vista única e contínua — projetos ocupam regiões distintas do canvas,
 * sem moldura separando um do outro; quem isola um projeto é o filtro.
 * Zoom/pan viram pinch/arrastar, e o node selecionado abre o card num overlay
 * inferior.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Svg, { G, Line, Circle, Rect, Text as SvgText } from 'react-native-svg'
import { Crosshair, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { Memory } from '@orbit/shared'
import {
  LABEL_HEIGHT,
  LABEL_OFFSET,
  layoutMemoryGraph,
  nodeLabelText,
  normalizeText,
} from '@orbit/shared'
import type { LayoutNode } from '@orbit/shared'
import { KIND_COLOR, kindLabel, lastActivity } from './meta'
import { MemoryCard } from './MemoryCard'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const RECENT_MS = 7 * 24 * 60 * 60 * 1000
const STALE_MS = 30 * 24 * 60 * 60 * 1000
/** Piso do zoom — baixo o bastante para um grafo grande caber inteiro. */
const ZOOM_MIN = 0.04

/**
 * Retângulo realmente ocupado pelo nó: o círculo unido ao rótulo centrado
 * abaixo. Enquadrar por (x, y) apenas cortaria os rótulos das bordas.
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
  const { t } = useTranslation()
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 })
  const [size, setSize] = useState({ w: 0, h: 0 })
  const gestureBase = useRef<Transform>({ x: 0, y: 0, k: 1 })
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const { nodes, edges } = useMemo(() => layoutMemoryGraph(pool, { inferEdges: true }), [pool])
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.memory.id, n])), [nodes])

  const queryTokens = normalizeText(query).split(' ').filter(Boolean)
  const matchesQuery = useCallback(
    (memory: Memory) => {
      if (queryTokens.length === 0) return true
      const haystack = normalizeText(`${memory.text} ${memory.tags.join(' ')}`)
      return queryTokens.every((tok) => haystack.includes(tok))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tokens derivam de query
    [query],
  )

  /** Reenquadra o conteúdo no container. */
  const fitView = useCallback(
    (w = size.w, h = size.h) => {
      if (!w || !h || nodes.length === 0) return
      const boxes = nodes.map(extentOf)
      const pad = 80
      const minX = Math.min(...boxes.map((b) => b.minX)) - pad
      const maxX = Math.max(...boxes.map((b) => b.maxX)) + pad
      const minY = Math.min(...boxes.map((b) => b.minY)) - pad
      const maxY = Math.max(...boxes.map((b) => b.maxY)) + pad
      // Grafos grandes ficam bem abaixo do piso do pinch — sem o clamp,
      // "centralizar" levava a um zoom do qual o gesto não conseguia voltar.
      const k = Math.max(ZOOM_MIN, Math.min(w / (maxX - minX), h / (maxY - minY), 1.4))
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
      const k = Math.min(3, Math.max(ZOOM_MIN, base.k * e.scale))
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
          <Text style={[s.centerBtnText, { color: tokens.foreground }]}>{t('memoryGraph.center')}</Text>
        </Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.legend}>
          {(Object.keys(KIND_COLOR) as Array<keyof typeof KIND_COLOR>).map((kind) => (
            <View key={kind} style={s.legendItem}>
              <View style={[s.legendDot, { backgroundColor: KIND_COLOR[kind] }]} />
              <Text style={[s.legendText, { color: tokens.mutedForeground }]}>{kindLabel(kind)}</Text>
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
                // Todas as arestas são retas — num grafo que cresce em todas as
                // direções, curva só embaralha. O que separa os tipos é o traço.
                const tree = edge.kind === 'tree'
                return (
                  <Line
                    key={`${edge.from}:${edge.to}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={
                      tree
                        ? 'rgba(138,142,153,0.45)'
                        : edge.kind === 'inferred'
                          ? 'rgba(138,142,153,0.2)'
                          : tokens.primary
                    }
                    strokeOpacity={edge.kind === 'cross' ? 0.3 : 1}
                    strokeWidth={tree ? 1 + Math.min(edge.hits / 14, 1.4) : 1}
                    strokeDasharray={tree ? undefined : edge.kind === 'inferred' ? '3 5' : '6 4'}
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
                const label = nodeLabelText(memory, node.isRoot)
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
                    {/* Círculo + rótulo centrado abaixo (estilo Obsidian). O
                        deslocamento vertical do texto vem de LABEL_OFFSET, o
                        mesmo valor que a colisão do layout reserva. */}
                    <Circle
                      r={node.r}
                      fill={color}
                      fillOpacity={node.isRoot ? 0.3 : memory.area ? 0.16 : 0.24}
                      stroke={color}
                      strokeWidth={isSelected ? 2.5 : node.isRoot ? 2 : 1.2}
                    />
                    <SvgText
                      y={node.r + LABEL_OFFSET + 10}
                      textAnchor="middle"
                      fontSize={node.isRoot ? 13 : memory.area ? 11 : 10}
                      fontWeight={node.isRoot ? '700' : memory.area ? '600' : '400'}
                      fill={tokens.foreground}
                    >
                      {label}
                    </SvgText>
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
