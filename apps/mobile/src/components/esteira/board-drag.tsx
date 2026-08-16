/**
 * Drag & drop do board via react-native-reanimated-dnd: cada task é um
 * Draggable (long-press via preDragDelay — toque rápido continua abrindo a
 * task e deslizar rápido continua rolando) e cada seção é um Droppable. O
 * card sai da própria posição seguindo o dedo (animado pela lib, UI thread).
 *
 * Regras: concluída nunca arrasta (dragDisabled); a validação de destino
 * ("pendente vai para qualquer fase, quem já começou só avança") fica com o
 * board — as seções recebem dropDisabled calculado com a task arrastada.
 *
 * Auto-scroll: quando o dedo chega perto das bordas do viewport, o provider
 * rola o ScrollView e pede à lib para recalcular as zonas
 * (requestPositionUpdate).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { View } from 'react-native'
import type { ScrollView } from 'react-native'
import { GestureDetector } from 'react-native-gesture-handler'
import Animated from 'react-native-reanimated'
import { DropProvider, useDraggable } from 'react-native-reanimated-dnd'
import type { DropProviderRef } from 'react-native-reanimated-dnd'
import type { Task } from '@orbit/shared'

/** Payload do onDragging do DropProvider (tipo inline na lib). */
interface PayloadArrasto {
  x: number
  y: number
  tx: number
  ty: number
  itemData: unknown
}

interface BoardDragContexto {
  /** Ref do ScrollView do board (para o auto-scroll). */
  registrarScrollRef: (ref: ScrollView | null) => void
  /** Altura do viewport (onLayout do ScrollView). */
  registrarViewport: (altura: number) => void
  /** Offset rolado (onScroll do board) — base do auto-scroll. */
  registrarScrollOffset: (offset: number) => void
  /** Task sendo arrastada — as seções calculam dropDisabled com ela. */
  arrastando: Task | null
}

const Ctx = createContext<BoardDragContexto | null>(null)

export function useBoardDrag(): BoardDragContexto {
  const valor = useContext(Ctx)
  if (!valor) throw new Error('useBoardDrag fora do BoardDragProvider')
  return valor
}

const MARGEM_AUTOSCROLL = 90
const PASSO_AUTOSCROLL = 10
const INTERVALO_AUTOSCROLL = 16

export function BoardDragProvider({ children }: { children: ReactNode }) {
  const [arrastando, setArrastando] = useState<Task | null>(null)
  const dropProviderRef = useRef<DropProviderRef | null>(null)
  const scrollRef = useRef<ScrollView | null>(null)
  const viewportRef = useRef(0)
  const offsetRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current)
    },
    [],
  )

  const pararAutoScroll = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const aoDragging = useCallback(
    ({ y, ty }: PayloadArrasto) => {
      const dedoY = y + ty
      const altura = viewportRef.current
      if (!altura || !scrollRef.current) return
      let direcao: 1 | -1 | null = null
      if (dedoY < MARGEM_AUTOSCROLL) direcao = -1
      else if (dedoY > altura - MARGEM_AUTOSCROLL) direcao = 1
      if (!direcao) {
        pararAutoScroll()
        return
      }
      if (timerRef.current) return
      timerRef.current = setInterval(() => {
        offsetRef.current = Math.max(0, offsetRef.current + direcao * PASSO_AUTOSCROLL)
        scrollRef.current?.scrollTo({ y: offsetRef.current, animated: false })
        // As zonas (Droppable) se movem com a rolagem — a lib re-mede.
        dropProviderRef.current?.requestPositionUpdate()
      }, INTERVALO_AUTOSCROLL)
    },
    [pararAutoScroll],
  )

  const registrarScrollRef = useCallback((ref: ScrollView | null) => {
    scrollRef.current = ref
  }, [])

  const registrarViewport = useCallback((altura: number) => {
    viewportRef.current = altura
  }, [])

  const registrarScrollOffset = useCallback((offset: number) => {
    offsetRef.current = offset
  }, [])

  const aoDragStart = useCallback((data: Task) => {
    setArrastando(data)
  }, [])

  const aoDragEnd = useCallback(() => {
    setArrastando(null)
    pararAutoScroll()
  }, [pararAutoScroll])

  return (
    <Ctx.Provider value={{ registrarScrollRef, registrarViewport, registrarScrollOffset, arrastando }}>
      <DropProvider
        ref={dropProviderRef}
        onDragStart={aoDragStart}
        onDragEnd={aoDragEnd}
        onDragging={aoDragging}
      >
        <View style={{ flex: 1 }}>{children}</View>
      </DropProvider>
    </Ctx.Provider>
  )
}

/** Card com long-press para arrastar. Toque curto passa para os filhos
 *  (abrir a task); concluída nunca arrasta (dragDisabled). */
export function CartaoArrastavel({ task, children }: { task: Task; children: ReactNode }) {
  const { animatedViewProps, gesture } = useDraggable({
    data: task,
    preDragDelay: 280,
    dragDisabled: task.status === 'concluida',
  })

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View {...animatedViewProps} style={animatedViewProps.style}>
        {children}
      </Animated.View>
    </GestureDetector>
  )
}
