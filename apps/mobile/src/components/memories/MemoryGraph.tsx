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
import { memo, useCallback, useMemo, useRef, useState } from 'react'
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
import type { LayoutEdge, LayoutNode } from '@orbit/shared'
import { KIND_COLOR, kindLabel, lastActivity } from './meta'
import { MemoryCard } from './MemoryCard'
import { getThemeTokens } from '~/lib/theme-tokens'
import type { ThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const RECENT_MS = 7 * 24 * 60 * 60 * 1000
const STALE_MS = 30 * 24 * 60 * 60 * 1000
/** Piso do zoom — baixo o bastante para um grafo grande caber inteiro. */
const ZOOM_MIN = 0.04
const ZOOM_MAX = 3

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
  const [transform, setTransformState] = useState<Transform>({ x: 0, y: 0, k: 1 })
  const [size, setSize] = useState({ w: 0, h: 0 })
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  /** Valor vivo do transform. Os callbacks do gesto leem daqui em vez do
   *  state: o `onStart` do pinch dispara antes de o render do frame anterior
   *  ter acontecido, e ler o state capturado no closure dava uma base velha —
   *  era daí que vinha o salto ao encostar o segundo dedo. */
  const live = useRef<Transform>({ x: 0, y: 0, k: 1 })
  const setTransform = useCallback((next: Transform) => {
    live.current = next
    setTransformState(next)
  }, [])

  // `now` sai daqui junto com o layout de propósito: solto no corpo ele seria
  // um valor novo a cada frame do gesto e anularia o memo da cena. "Recente" e
  // "esquecida" passam a ser relativos ao momento em que o grafo foi montado.
  const { nodes, edges, now } = useMemo(
    () => ({ ...layoutMemoryGraph(pool, { inferEdges: true }), now: Date.now() }),
    [pool],
  )
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
    [nodes, size, setTransform],
  )

  // ─── Gestos ────────────────────────────────────────────────────────────
  // Pan e pinch tinham UMA base compartilhada e rodavam em Simultaneous: com
  // dois dedos na tela os dois estavam ativos, cada `onStart` sobrescrevia a
  // base do outro e os dois `onUpdate` escreviam o transform no mesmo frame.
  // Era essa disputa que fazia o zoom ir, voltar para a posição anterior e ir
  // de novo — e o último a escrever decidia onde o conteúdo parava ao soltar.
  //
  // Agora cada um tem base própria e eles não se sobrepõem: o pan só aceita um
  // dedo, e o pinch cuida do zoom E do arraste de dois dedos (o foco andando
  // já move o conteúdo).
  const panBase = useRef<Transform>({ x: 0, y: 0, k: 1 })
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .runOnJS(true)
        .onStart(() => {
          panBase.current = live.current
        })
        .onUpdate((e) => {
          const base = panBase.current
          setTransform({ k: base.k, x: base.x + e.translationX, y: base.y + e.translationY })
        }),
    [setTransform],
  )

  /** Ponto do CONTEÚDO que estava sob os dedos quando a pinça começou. */
  const pinchBase = useRef<{ t: Transform; cx: number; cy: number }>({
    t: { x: 0, y: 0, k: 1 },
    cx: 0,
    cy: 0,
  })
  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onStart((e) => {
          const t = live.current
          pinchBase.current = { t, cx: (e.focalX - t.x) / t.k, cy: (e.focalY - t.y) / t.k }
        })
        .onUpdate((e) => {
          const { t, cx, cy } = pinchBase.current
          const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, t.k * e.scale))
          // O ponto de ancoragem é fixo desde o início do gesto. Antes ele era
          // recalculado a cada frame a partir do foco ATUAL contra a base
          // ANTIGA, então a âncora escorregava junto com os dedos.
          setTransform({ k, x: e.focalX - cx * k, y: e.focalY - cy * k })
        }),
    [setTransform],
  )

  const composed = useMemo(
    () => Gesture.Simultaneous(panGesture, pinchGesture),
    [panGesture, pinchGesture],
  )

  const selected = selectedId ? allById.get(selectedId) : undefined
  // Guardado como elemento: com um nó selecionado, o card seria remontado a
  // cada frame de pan/pinch (o array `related` sozinho já era uma prop nova
  // por render). Mesma referência = React pula a subárvore.
  const selectedCard = useMemo(
    () =>
      selected ? (
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
      ) : null,
    [selected, allById, onSelect, tokens],
  )

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
              {/* Cena memoizada: enquanto o gesto roda, só os props deste <G>
                  mudam — sem isto cada frame reconciliava todos os nós e o
                  pinch engasgava no fio de JS. */}
              <GraphScene
                nodes={nodes}
                edges={edges}
                nodeById={nodeById}
                selectedId={selectedId}
                matchesQuery={matchesQuery}
                now={now}
                tokens={tokens}
                onSelect={onSelect}
              />
            </G>
          </Svg>
        </GestureDetector>

        {/* Card da memória selecionada — overlay inferior */}
        {selectedCard}
      </View>
    </View>
  )
}

/**
 * Arestas e nós do grafo. Memoizado de propósito: o transform vive no
 * componente de cima e muda a cada frame de pan/pinch — se a cena
 * re-renderizasse junto, cada frame reconstruiria centenas de elementos SVG na
 * thread de JS, que é o que fazia o gesto travar.
 */
const GraphScene = memo(function GraphScene({
  nodes,
  edges,
  nodeById,
  selectedId,
  matchesQuery,
  now,
  tokens,
  onSelect,
}: {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  nodeById: Map<string, LayoutNode>
  selectedId: string | null
  matchesQuery: (memory: Memory) => boolean
  now: number
  tokens: ThemeTokens
  onSelect: (id: string | null) => void
}) {
  return (
    <>
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
    </>
  )
})

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
