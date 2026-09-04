/**
 * Grafo de memórias — porte do memory-graph do desktop. O layout vem de
 * @orbit/shared (createMemoryGraphJob), então as duas plataformas desenham
 * exatamente as mesmas posições: a raiz do projeto no centro e os ramos
 * crescendo para todos os lados, com espaço mínimo garantido entre os rótulos.
 * É uma vista única e contínua — projetos ocupam regiões distintas do canvas,
 * sem moldura separando um do outro; quem isola um projeto é o filtro.
 *
 * O frame não passa pelo React nem pela thread de JS:
 *
 * 1. A cena inteira é gravada num SkPicture (ver graph-picture) quando o
 *    CONTEÚDO muda — layout novo, nível de zoom, busca. Desenhar virou
 *    reproduzir uma lista de comandos na GPU.
 * 2. Pan e pinch escrevem em shared values, e a transform do <Group> lê delas
 *    direto na thread de UI.
 *
 * Antes disto a cena era SVG: cada círculo, traço e rótulo era uma view nativa,
 * e mudar a transform obrigava o motor a redesenhar tudo em CPU. Algumas
 * centenas de nós já engasgavam o arraste.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, Platform } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import {
  cancelAnimation,
  runOnJS,
  useAnimatedReaction,
  useDerivedValue,
  useSharedValue,
  withDecay,
  withTiming,
} from 'react-native-reanimated'
import { Canvas, Circle, Group, Picture, matchFont } from '@shopify/react-native-skia'
import { Crosshair, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { Memory } from '@orbit/shared'
import { KIND_COLOR, kindLabel } from './meta'
import { useGraphLayout } from './use-graph-layout'
import { construirIndice, idsQueCasam } from './graph-index'
import type { IndiceGrafo, NoDesenho, Regiao } from './graph-index'
import { corSkia, gravarCena } from './graph-picture'
import type { Fontes } from './graph-picture'
import { MemoryCard } from './MemoryCard'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/** Piso do zoom — baixo o bastante para um grafo grande caber inteiro. */
const ZOOM_MIN = 0.04
const ZOOM_MAX = 3

// Níveis de detalhe. Cada faixa tira o que, naquele zoom, é pixel sujo: o
// rótulo (o mais caro de desenhar), depois o anel de recente, depois as arestas
// que não são da árvore. No fundo do poço o grafo vira um ponto por bloco.
const ZOOM_ROTULOS = 0.32
const ZOOM_ANEIS = 0.18
const ZOOM_NOS = 0.08

/** Folga de toque em volta do círculo do nó, em pixels de tela. */
const TOQUE_FOLGA = 14
/** Quanto o duplo toque aproxima de uma vez. */
const DUPLO_TOQUE_FATOR = 2.5
/** Espera do toque simples pelo duplo. O padrão do RNGH é 500 ms — meio
 *  segundo até o card abrir era tempo demais para um toque em nó. */
const DUPLO_TOQUE_ESPERA = 180
const DUPLO_TOQUE_MS = 200

interface Transform {
  x: number
  y: number
  k: number
}

/**
 * Faixa em que a translação de um eixo pode parar depois da inércia. Sem ela um
 * arremesso jogava o grafo para fora da tela e não havia como trazê-lo de volta
 * a não ser pelo "Centralizar".
 */
function limitesEixo(
  minMundo: number,
  maxMundo: number,
  escala: number,
  tela: number,
): [number, number] {
  'worklet'
  const margem = Math.min(tela * 0.4, 160)
  const lo = margem - maxMundo * escala
  const hi = tela - margem - minMundo * escala
  if (lo <= hi) return [lo, hi]
  // Conteúdo menor que a tela: não há faixa, então prende no meio.
  const meio = (lo + hi) / 2
  return [meio, meio]
}

const FAMILIA = Platform.select({ ios: 'Helvetica', default: 'sans-serif' })

export function MemoryGraph({ pool, allById, query, selectedId, onSelect }: {
  /** Memórias visíveis (filtro de modo/projeto — a busca só destaca) */
  pool: Memory[]
  allById: Map<string, Memory>
  query: string
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const { t } = useTranslation()
  const [size, setSize] = useState({ w: 0, h: 0 })
  /** A cena só aparece depois do primeiro enquadramento: antes dele o zoom
   *  ainda é 1 e o grafo seria desenhado gigante por um frame. */
  const [pronto, setPronto] = useState(false)
  /**
   * Nível de detalhe. Regravar a cena é o único trabalho pesado que sobrou,
   * então ele só muda quando o zoom cruza uma faixa — e não nos milhares de
   * valores intermediários por onde a pinça passa.
   */
  const [nivel, setNivel] = useState(3)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  // ─── Transform: vive na thread de UI ───────────────────────────────────
  const tx = useSharedValue(0)
  const ty = useSharedValue(0)
  const k = useSharedValue(1)
  const larguraSV = useSharedValue(0)
  const alturaSV = useSharedValue(0)
  /** Caixa do conteúdo inteiro — limita a inércia do arraste. */
  const limitesSV = useSharedValue<Regiao | null>(null)
  /** Zoom do último enquadramento — referência do duplo toque. */
  const escalaFitSV = useSharedValue(1)

  // A transform do canvas inteiro, lida pelo Skia na própria thread de UI.
  const transformSV = useDerivedValue(() => [
    { translateX: tx.get() },
    { translateY: ty.get() },
    { scale: k.get() },
  ])

  // O layout é pesado e vem em fatias (ver useGraphLayout); `now` chega junto
  // dele de propósito: solto no corpo seria um valor novo a cada frame.
  const { layout, now, progress, building } = useGraphLayout(pool)

  const corTexto = useMemo(() => corSkia(tokens.foreground), [tokens.foreground])
  const corPrimaria = useMemo(() => corSkia(tokens.primary), [tokens.primary])

  // Tudo que a cena precisa por nó, calculado uma vez por layout.
  const indice = useMemo(
    () => construirIndice(layout, now, corPrimaria),
    [layout, now, corPrimaria],
  )

  // A busca percorre o texto inteiro de cada memória. Adiada, ela deixa de
  // acontecer a cada tecla digitada — e o resultado é um Set consultado por id
  // na gravação, em vez de uma normalização por nó por render.
  const queryAdiada = useDeferredValue(query)
  const casam = useMemo(() => idsQueCasam(pool, queryAdiada), [pool, queryAdiada])

  const fontes: Fontes = useMemo(
    () => ({
      fato: matchFont({ fontFamily: FAMILIA, fontSize: 10 }),
      area: matchFont({ fontFamily: FAMILIA, fontSize: 11, fontWeight: '600' }),
      raiz: matchFont({ fontFamily: FAMILIA, fontSize: 13, fontWeight: 'bold' }),
    }),
    [],
  )

  /** Ligado no primeiro gesto: a partir daí a câmera é do usuário. */
  const interagiu = useRef(false)
  const marcarInteracao = useCallback(() => {
    interagiu.current = true
  }, [])

  const aplicar = useCallback(
    (destino: Transform) => {
      cancelAnimation(tx)
      cancelAnimation(ty)
      tx.set(destino.x)
      ty.set(destino.y)
      k.set(destino.k)
    },
    [tx, ty, k],
  )

  /** Reenquadra o conteúdo no container. */
  const fitView = useCallback(
    (w = size.w, h = size.h) => {
      if (!w || !h || indice.total === 0) return
      const limites = indice.limites
      limitesSV.set(limites)
      const pad = 80
      const minX = limites.minX - pad
      const maxX = limites.maxX + pad
      const minY = limites.minY - pad
      const maxY = limites.maxY + pad
      // Grafos grandes ficam bem abaixo do piso do pinch — sem o clamp,
      // "centralizar" levava a um zoom do qual o gesto não conseguia voltar.
      const escala = Math.max(ZOOM_MIN, Math.min(w / (maxX - minX), h / (maxY - minY), 1.4))
      escalaFitSV.set(escala)
      aplicar({
        k: escala,
        x: w / 2 - ((minX + maxX) / 2) * escala,
        y: h / 2 - ((minY + maxY) / 2) * escala,
      })
      setPronto(true)
      setNivel(escala >= ZOOM_ROTULOS ? 3 : escala >= ZOOM_ANEIS ? 2 : escala >= ZOOM_NOS ? 1 : 0)
    },
    [indice, size, aplicar, limitesSV, escalaFitSV],
  )

  // ─── Gestos ────────────────────────────────────────────────────────────
  // Tudo em worklet: nenhum destes callbacks acorda a thread de JS.
  //
  // Pan e pinch têm bases separadas e não se sobrepõem: o pan só aceita um
  // dedo, e o pinch cuida do zoom E do arraste de dois dedos (o foco andando já
  // move o conteúdo). Quando os dois dividiam uma base, cada `onStart`
  // sobrescrevia a do outro e o zoom ia, voltava e ia de novo.
  const panBaseX = useSharedValue(0)
  const panBaseY = useSharedValue(0)
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .onStart(() => {
          'worklet'
          cancelAnimation(tx)
          cancelAnimation(ty)
          panBaseX.set(tx.get())
          panBaseY.set(ty.get())
          runOnJS(marcarInteracao)()
        })
        .onUpdate((e) => {
          'worklet'
          // Arraste é coisa de um dedo só. O `maxPointers(1)` já reprova o
          // gesto quando um segundo dedo encosta, mas a checagem aqui é de
          // graça e não depende desse detalhe do RNGH.
          if (e.numberOfPointers !== 1) return
          tx.set(panBaseX.get() + e.translationX)
          ty.set(panBaseY.get() + e.translationY)
        })
        .onEnd((e) => {
          'worklet'
          // Inércia: o conteúdo continua no embalo e freia sozinho, preso à
          // faixa em que ainda sobra grafo na tela.
          const limites = limitesSV.get()
          if (!limites) return
          const [loX, hiX] = limitesEixo(limites.minX, limites.maxX, k.get(), larguraSV.get())
          const [loY, hiY] = limitesEixo(limites.minY, limites.maxY, k.get(), alturaSV.get())
          tx.set(withDecay({ velocity: e.velocityX, clamp: [loX, hiX], rubberBandEffect: true }))
          ty.set(withDecay({ velocity: e.velocityY, clamp: [loY, hiY], rubberBandEffect: true }))
        }),
    [tx, ty, k, panBaseX, panBaseY, limitesSV, larguraSV, alturaSV, marcarInteracao],
  )

  /** Ponto do CONTEÚDO que estava sob os dedos quando a pinça começou. */
  const pinchBaseK = useSharedValue(1)
  const pinchFocoX = useSharedValue(0)
  const pinchFocoY = useSharedValue(0)
  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onStart((e) => {
          'worklet'
          cancelAnimation(tx)
          cancelAnimation(ty)
          runOnJS(marcarInteracao)()
          pinchBaseK.set(k.get())
          pinchFocoX.set((e.focalX - tx.get()) / k.get())
          pinchFocoY.set((e.focalY - ty.get()) / k.get())
        })
        .onUpdate((e) => {
          'worklet'
          // Ao soltar a pinça um dedo sai antes do outro, e o foco — que é o
          // ponto médio entre eles — colapsa em cima do que ficou. Esse update
          // é um salto, não um gesto: aplicá-lo puxava o canvas na direção do
          // dedo restante em vez de parar no zoom onde a pinça terminou.
          if (e.numberOfPointers < 2) return
          const escala = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinchBaseK.get() * e.scale))
          // O ponto de ancoragem é fixo desde o início do gesto. Recalculá-lo a
          // cada frame a partir do foco ATUAL contra a base ANTIGA fazia a
          // âncora escorregar junto com os dedos.
          k.set(escala)
          tx.set(e.focalX - pinchFocoX.get() * escala)
          ty.set(e.focalY - pinchFocoY.get() * escala)
        }),
    [tx, ty, k, pinchBaseK, pinchFocoX, pinchFocoY, marcarInteracao],
  )

  // Toque: um handler só, com acerto por distância. Com a cena gravada num
  // picture não há mais view por nó para receber o dedo — e não fazia sentido
  // haver: eram milhares de alvos de toque só para descobrir um círculo.
  const indiceRef = useRef<IndiceGrafo>(indice)
  useEffect(() => {
    indiceRef.current = indice
  }, [indice])
  /** No modo resumido não há nó desenhado para acertar. */
  const resumidoRef = useRef(false)
  const tocar = useCallback(
    (wx: number, wy: number, escala: number) => {
      if (resumidoRef.current) return
      const folga = TOQUE_FOLGA / escala
      let melhor: NoDesenho | null = null
      let melhorDist = Infinity
      for (const no of indiceRef.current.nos) {
        const dx = no.x - wx
        const dy = no.y - wy
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist <= no.r + folga && dist < melhorDist) {
          melhorDist = dist
          melhor = no
        }
      }
      if (!melhor) return
      const id = melhor.id
      onSelect(id === selectedId ? null : id)
    },
    [onSelect, selectedId],
  )
  const tapGesture = useMemo(
    () =>
      Gesture.Tap()
        .maxDistance(12)
        .onEnd((e, sucesso) => {
          'worklet'
          // O onEnd também chega quando o toque virou arraste e o gesto falhou.
          if (!sucesso) return
          runOnJS(tocar)((e.x - tx.get()) / k.get(), (e.y - ty.get()) / k.get(), k.get())
        }),
    [tocar, tx, ty, k],
  )

  // Duplo toque: aproxima ancorado no ponto tocado e, já aproximado, volta para
  // a vista inteira. Com o piso do zoom em 4% da escala, chegar perto só na
  // pinça exigia vários gestos seguidos.
  const duploToque = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .maxDistance(24)
        .maxDelay(DUPLO_TOQUE_ESPERA)
        .onEnd((e, sucesso) => {
          'worklet'
          if (!sucesso) return
          runOnJS(marcarInteracao)()
          const atual = k.get()
          const volta = atual > escalaFitSV.get() * 1.5
          const alvo = volta ? escalaFitSV.get() : Math.min(ZOOM_MAX, atual * DUPLO_TOQUE_FATOR)
          // Ponto do conteúdo sob o dedo: é ele que fica parado enquanto o
          // zoom anda.
          const mx = (e.x - tx.get()) / atual
          const my = (e.y - ty.get()) / atual
          k.set(withTiming(alvo, { duration: DUPLO_TOQUE_MS }))
          tx.set(withTiming(e.x - mx * alvo, { duration: DUPLO_TOQUE_MS }))
          ty.set(withTiming(e.y - my * alvo, { duration: DUPLO_TOQUE_MS }))
        }),
    [tx, ty, k, escalaFitSV, marcarInteracao],
  )

  // Exclusive: o toque simples só vale depois que o duplo falhou, senão o
  // primeiro toque de um duplo já abriria o card.
  const composed = useMemo(
    () => Gesture.Simultaneous(panGesture, pinchGesture, Gesture.Exclusive(duploToque, tapGesture)),
    [panGesture, pinchGesture, duploToque, tapGesture],
  )

  /**
   * Enquadramento: uma vez quando o grafo aparece e uma vez quando o layout
   * fica pronto — não a cada prévia.
   *
   * O layout em fatias publica uma prévia por vez; reenquadrar a cada uma
   * fazia a câmera pular junto com os nós se assentando, que era metade da
   * sensação de "ele fica reorganizando".
   */
  const enquadrou = useRef<'nao' | 'previa' | 'final'>('nao')
  useEffect(() => {
    if (!size.w || !size.h || indice.total === 0) return
    const alvo = building ? 'previa' : 'final'
    if (enquadrou.current === alvo || enquadrou.current === 'final') return
    // Quem já arrastou ou deu zoom mandou na câmera: o enquadramento final não
    // passa por cima disso.
    if (alvo === 'final' && interagiu.current && enquadrou.current !== 'nao') {
      enquadrou.current = 'final'
      return
    }
    enquadrou.current = alvo
    fitView(size.w, size.h)
  }, [indice, size, building, fitView])

  // ─── Nível de detalhe ──────────────────────────────────────────────────
  useAnimatedReaction(
    () => {
      const escala = k.get()
      return escala >= ZOOM_ROTULOS ? 3 : escala >= ZOOM_ANEIS ? 2 : escala >= ZOOM_NOS ? 1 : 0
    },
    (agora, antes) => {
      'worklet'
      if (agora !== antes) runOnJS(setNivel)(agora)
    },
  )

  useEffect(() => {
    resumidoRef.current = nivel === 0
  }, [nivel])

  // A cena gravada. É aqui que mora o custo — e ele só é pago quando o layout,
  // o zoom de detalhe, a busca ou o tema mudam.
  const picture = useMemo(
    () => gravarCena(indice, { nivel, casam, fontes, corTexto }),
    [indice, nivel, casam, fontes, corTexto],
  )

  const selecionado = useMemo(
    () => (selectedId ? indice.nos.find((n) => n.id === selectedId) : undefined),
    [indice, selectedId],
  )

  const selected = selectedId ? allById.get(selectedId) : undefined
  // Guardado como elemento: com um nó selecionado, o card seria remontado a
  // cada render (o array `related` sozinho já era uma prop nova por render).
  const selectedCard = useMemo(
    () =>
      selected ? (
        <View style={s.selectedOverlay}>
          <Pressable
            onPress={() => onSelect(null)}
            style={[s.selectedClose, { backgroundColor: tokens.muted }]}
          >
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

  const pct = Math.round(progress * 100)

  return (
    <View style={{ flex: 1, gap: 8 }}>
      {/* Toolbar: centralizar + legenda */}
      <View style={s.toolbar}>
        <Pressable onPress={() => fitView()} style={[s.centerBtn, { borderColor: tokens.border }]}>
          <Crosshair size={13} color={tokens.foreground} />
          <Text style={[s.centerBtnText, { color: tokens.foreground }]}>
            {t('memoryGraph.center')}
          </Text>
        </Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.legend}>
          {(Object.keys(KIND_COLOR) as (keyof typeof KIND_COLOR)[]).map((kind) => (
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
          larguraSV.set(width)
          alturaSV.set(height)
          setSize((atual) => (atual.w === width && atual.h === height ? atual : { w: width, h: height }))
        }}
      >
        <GestureDetector gesture={composed}>
          <Canvas style={s.skia}>
            <Group transform={transformSV}>
              {pronto && picture && <Picture picture={picture} />}
              {/* Realce do selecionado fora do picture: é o que muda a toque de
                  dedo, e regravar a cena inteira por causa dele seria absurdo. */}
              {pronto && selecionado && (
                <>
                  <Circle
                    cx={selecionado.x}
                    cy={selecionado.y}
                    r={selecionado.r + 4}
                    color={selecionado.cor}
                    style="stroke"
                    strokeWidth={2.5}
                    opacity={0.9}
                  />
                  <Circle
                    cx={selecionado.x}
                    cy={selecionado.y}
                    r={selecionado.r}
                    color={selecionado.cor}
                    style="stroke"
                    strokeWidth={2.5}
                  />
                </>
              )}
            </Group>
          </Canvas>
        </GestureDetector>

        {/* Layout em construção. Com prévia no ar ele vira uma tarja discreta no
            canto; sem prévia (grafo grande demais) ocupa o centro. */}
        {building && !layout && (
          <View style={s.building}>
            <Text style={[s.buildingText, { color: tokens.mutedForeground }]}>
              {t('memoryGraph.building')}
            </Text>
            <View style={[s.barra, { backgroundColor: tokens.muted }]}>
              <View style={[s.barraCheia, { backgroundColor: tokens.primary, width: `${pct}%` }]} />
            </View>
            <Text style={[s.buildingPct, { color: tokens.mutedForeground }]}>{pct}%</Text>
          </View>
        )}
        {building && layout && (
          <View style={[s.chip, { backgroundColor: tokens.muted }]}>
            <Text style={[s.chipText, { color: tokens.mutedForeground }]}>
              {t('memoryGraph.building')} {pct}%
            </Text>
          </View>
        )}

        {/* Card da memória selecionada — overlay inferior */}
        {selectedCard}
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
  skia: { flex: 1 },

  building: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buildingText: { fontSize: 12 },
  buildingPct: { fontSize: 11, fontVariant: ['tabular-nums'] },
  barra: { width: 160, height: 4, borderRadius: 2, overflow: 'hidden' },
  barraCheia: { height: 4, borderRadius: 2 },

  chip: {
    position: 'absolute',
    top: 8,
    left: 8,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipText: { fontSize: 11, fontVariant: ['tabular-nums'] },

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
