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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Svg, { G, Line, Circle, Text as SvgText } from 'react-native-svg'
import { Crosshair, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { Memory } from '@orbit/shared'
import {
  LABEL_HEIGHT,
  LABEL_OFFSET,
  nodeLabelText,
  normalizeText,
} from '@orbit/shared'
import type { LayoutEdge, LayoutNode } from '@orbit/shared'
import { KIND_COLOR, kindLabel, lastActivity } from './meta'
import { useGraphLayout } from './use-graph-layout'
import { MemoryCard } from './MemoryCard'
import { getThemeTokens } from '~/lib/theme-tokens'
import type { ThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const RECENT_MS = 7 * 24 * 60 * 60 * 1000
const STALE_MS = 30 * 24 * 60 * 60 * 1000
/** Piso do zoom — baixo o bastante para um grafo grande caber inteiro. */
const ZOOM_MIN = 0.04
const ZOOM_MAX = 3

/** Abaixo deste zoom o rótulo é um borrão de 3px: desenhar o texto (o elemento
 *  mais caro do SVG, um por nó) só custa frame. */
const LABEL_MIN_ZOOM = 0.32
/** Anel de "recente"/selecionado some junto com os rótulos — no zoom de longe
 *  ele vira um pixel em volta do círculo. */
const HALO_MIN_ZOOM = 0.18

const EMPTY_NODES: LayoutNode[] = []
const EMPTY_EDGES: LayoutEdge[] = []

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

interface Region {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** Retângulo do CONTEÚDO visível no container, dado o transform atual. */
function visibleWorldRect(t: Transform, size: { w: number; h: number }): Region {
  return {
    minX: -t.x / t.k,
    minY: -t.y / t.k,
    maxX: (size.w - t.x) / t.k,
    maxY: (size.h - t.y) / t.k,
  }
}

/** Uma tela de folga para cada lado: o conteúdo que entra durante o arraste já
 *  está montado quando aparece. */
function expand(r: Region): Region {
  const mw = (r.maxX - r.minX) || 1
  const mh = (r.maxY - r.minY) || 1
  return { minX: r.minX - mw, maxX: r.maxX + mw, minY: r.minY - mh, maxY: r.maxY + mh }
}

function contains(outer: Region, inner: Region): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  )
}

function areaRatio(inner: Region, outer: Region): number {
  const areaOuter = (outer.maxX - outer.minX) * (outer.maxY - outer.minY)
  if (areaOuter <= 0) return 1
  return ((inner.maxX - inner.minX) * (inner.maxY - inner.minY)) / areaOuter
}

function intersects(a: Region, b: Region): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY
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
  // Um commit por frame. Os callbacks do gesto chegam na thread de JS e podiam
  // vir mais de uma vez entre dois frames — cada um disparava um render e um
  // redesenho do SVG inteiro. O primeiro evento do frame agenda; os seguintes
  // só atualizam o valor vivo.
  const frame = useRef<number | null>(null)
  const setTransform = useCallback((next: Transform) => {
    live.current = next
    if (frame.current != null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      setTransformState(live.current)
    })
  }, [])
  useEffect(
    () => () => {
      if (frame.current != null) cancelAnimationFrame(frame.current)
    },
    [],
  )

  // O layout é O(n²) e roda fora do primeiro render (ver useGraphLayout); `now`
  // vem junto dele de propósito: solto no corpo seria um valor novo a cada
  // frame do gesto e anularia o memo da cena.
  const { layout, now } = useGraphLayout(pool)
  const nodes = layout?.nodes ?? EMPTY_NODES
  const edges = layout?.edges ?? EMPTY_EDGES
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
      // Uma passada só, sem spread: `Math.min(...array)` percorre quatro vezes
      // e estoura a pilha em grafo grande (o limite de argumentos).
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const node of nodes) {
        const b = extentOf(node)
        if (b.minX < minX) minX = b.minX
        if (b.maxX > maxX) maxX = b.maxX
        if (b.minY < minY) minY = b.minY
        if (b.maxY > maxY) maxY = b.maxY
      }
      const pad = 80
      minX -= pad
      maxX += pad
      minY -= pad
      maxY += pad
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
          // Arraste é coisa de um dedo só. O `maxPointers(1)` já reprova o
          // gesto quando um segundo dedo encosta, mas a checagem aqui é de
          // graça e não depende desse detalhe do RNGH.
          if (e.numberOfPointers !== 1) return
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
          // Ao soltar a pinça um dedo sai antes do outro, e o foco — que é o
          // ponto médio entre eles — colapsa em cima do que ficou. Esse update
          // é um salto, não um gesto: aplicá-lo puxava o canvas na direção do
          // dedo restante em vez de parar no zoom onde a pinça terminou.
          // Ignorando, o transform fica no último estado de dois dedos.
          if (e.numberOfPointers < 2) return
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

  // O layout chega depois do primeiro render: enquadrar só no onLayout deixava
  // o grafo fora de vista (naquele momento ainda não havia nós).
  const framed = useRef<LayoutNode[] | null>(null)
  useEffect(() => {
    if (!size.w || !size.h || nodes.length === 0 || framed.current === nodes) return
    framed.current = nodes
    fitView(size.w, size.h)
  }, [nodes, size, fitView])

  // ─── Culling ───────────────────────────────────────────────────────────
  // Só entra na cena o que está perto da tela. A região é folgada (uma tela
  // inteira de margem para cada lado) e só é recalculada quando a área visível
  // sai dela — assim o memo da cena sobrevive à maior parte dos frames de pan,
  // em vez de reconstruir centenas de elementos SVG a cada um.
  // A região carrega os nós a que pertence: pool novo (filtro/projeto)
  // reposiciona tudo, e a região antiga deixa de valer sozinha — sem precisar
  // de um efeito só para zerá-la.
  const [regionState, setRegion] = useState<{ nodes: LayoutNode[]; rect: Region } | null>(null)
  const region = regionState && regionState.nodes === nodes ? regionState.rect : null
  useEffect(() => {
    if (!size.w || !size.h || nodes.length === 0) return
    const visivel = visibleWorldRect(transform, size)
    // Recalcula quando a área visível sai da região OU quando ela ficou muito
    // menor que a região (zoom para dentro): sem o segundo caso, aproximar
    // continuaria desenhando o grafo inteiro herdado do enquadramento anterior.
    // O expand() devolve 9x a área visível, bem acima do limiar — não repica.
    if (region && contains(region, visivel) && areaRatio(visivel, region) > 0.05) return
    setRegion({ nodes, rect: expand(visivel) })
  }, [transform, size, nodes, region])

  const visible = useMemo(() => {
    // Sem região definida ainda (primeiro frame), desenha tudo: é o mesmo
    // enquadramento do fitView, em que o grafo inteiro cabe na tela.
    if (!region) return { nodes, edges }
    const dentro = nodes.filter((node) => intersects(region, extentOf(node)))
    const ids = new Set(dentro.map((n) => n.memory.id))
    return {
      nodes: dentro,
      edges: edges.filter((edge) => {
        if (ids.has(edge.from) || ids.has(edge.to)) return true
        // Aresta longa atravessando a tela com as duas pontas fora: mantém
        // pelo retângulo que ela ocupa, senão some um traço que aparecia.
        const a = nodeById.get(edge.from)
        const b = nodeById.get(edge.to)
        if (!a || !b) return false
        return intersects(region, {
          minX: Math.min(a.x, b.x),
          maxX: Math.max(a.x, b.x),
          minY: Math.min(a.y, b.y),
          maxY: Math.max(a.y, b.y),
        })
      }),
    }
  }, [region, nodes, edges, nodeById])

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
          setSize((atual) => (atual.w === width && atual.h === height ? atual : { w: width, h: height }))
        }}
      >
        <GestureDetector gesture={composed}>
          <Svg width="100%" height="100%">
            <G translateX={transform.x} translateY={transform.y} scale={transform.k}>
              {/* Cena memoizada: enquanto o gesto roda, só os props deste <G>
                  mudam — sem isto cada frame reconciliava todos os nós e o
                  pinch engasgava no fio de JS. */}
              <GraphScene
                nodes={visible.nodes}
                edges={visible.edges}
                nodeById={nodeById}
                selectedId={selectedId}
                matchesQuery={matchesQuery}
                now={now}
                tokens={tokens}
                onSelect={onSelect}
                showLabels={transform.k >= LABEL_MIN_ZOOM}
                showHalos={transform.k >= HALO_MIN_ZOOM}
              />
            </G>
          </Svg>
        </GestureDetector>

        {/* Layout ainda em construção (grafo grande = simulação de forças) */}
        {!layout && (
          <View style={s.building}>
            <Text style={[s.buildingText, { color: tokens.mutedForeground }]}>
              {t('memoryGraph.building')}
            </Text>
          </View>
        )}

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
  showLabels,
  showHalos,
}: {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  nodeById: Map<string, LayoutNode>
  selectedId: string | null
  matchesQuery: (memory: Memory) => boolean
  now: number
  tokens: ThemeTokens
  onSelect: (id: string | null) => void
  /** Zoom de longe não desenha rótulo nem anel — texto é o elemento mais caro
   *  do SVG e ali ele é ilegível de qualquer forma. */
  showLabels: boolean
  showHalos: boolean
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
        const label = showLabels || node.isRoot ? nodeLabelText(memory, node.isRoot) : ''
        return (
          <G
            key={memory.id}
            translateX={node.x}
            translateY={node.y}
            opacity={opacity}
            onPress={() => onSelect(isSelected ? null : memory.id)}
          >
            {showHalos && !node.isRoot && (recent || isSelected) && (
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
            {(showLabels || node.isRoot) && (
              <SvgText
                y={node.r + LABEL_OFFSET + 10}
                textAnchor="middle"
                fontSize={node.isRoot ? 13 : memory.area ? 11 : 10}
                fontWeight={node.isRoot ? '700' : memory.area ? '600' : '400'}
                fill={tokens.foreground}
              >
                {label}
              </SvgText>
            )}
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

  building: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  buildingText: { fontSize: 12 },

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
