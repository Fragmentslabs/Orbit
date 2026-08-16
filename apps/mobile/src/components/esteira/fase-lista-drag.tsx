/**
 * DnD de reordenação da lista de fases (form de esteira) via
 * react-native-reanimated-dnd: `useSortableList` gerencia a lista (positions,
 * auto-scroll do ScrollView) e cada linha usa `useSortable`. O card sai da
 * própria posição seguindo o dedo (animado pela lib, UI thread) e os demais
 * deslizam AO VIVO para abrir espaço — soltar não commita nada, a ordem já
 * foi aplicada durante o arrasto via onMove.
 *
 * As linhas são identificadas por `chave` estável: reordenações NÃO desmontam
 * componentes (o que mataria o gesto ativo) — o React só muda a ordem.
 *
 * O form aplica no ScrollView principal: ref={scrollViewRef},
 * onScroll={handleScroll}, onScrollEndDrag/MomentumScrollEnd={handleScrollEnd}
 * e minHeight={contentHeight} no contentContainerStyle.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { StyleSheet } from 'react-native'
import { GestureDetector } from 'react-native-gesture-handler'
import Animated from 'react-native-reanimated'
import { DropProvider, useSortable, useSortableList } from 'react-native-reanimated-dnd'
import type { UseSortableListReturn } from 'react-native-reanimated-dnd'

/** Gap do container de fases no form (gap: 6) — o passo do sortable é
 *  altura da linha + gap. */
const GAP_LINHAS = 6
/** Altura inicial antes da primeira medição (onLayout da linha). */
const ALTURA_INICIAL = 56

interface FaseListaDragContexto extends UseSortableListReturn<{ id: string }> {
  /** onMove da lib: (id, de, para) — repassa para o form. */
  onMover: (id: string, de: number, para: number) => void
  /** Medição da primeira linha (alturas uniformes) → itemHeight do sortable. */
  registrarAlturaLinha: (altura: number) => void
}

const Ctx = createContext<FaseListaDragContexto | null>(null)

export function useFaseListaDrag(): FaseListaDragContexto {
  const valor = useContext(Ctx)
  if (!valor) throw new Error('useFaseListaDrag fora do FaseListaDragProvider')
  return valor
}

export function FaseListaDragProvider({
  fases,
  onMover,
  children,
}: {
  /** Fases na ordem ATUAL (só as chaves importam para a lib). */
  fases: { chave: string }[]
  /** Reordenação pedida durante o arrasto: mover a fase de `de` para `para`. */
  onMover: (de: number, para: number) => void
  children: ReactNode
}) {
  const [alturaLinha, setAlturaLinha] = useState(ALTURA_INICIAL)
  const data = useMemo(() => fases.map((f) => ({ id: f.chave })), [fases])
  const lista = useSortableList({
    data,
    itemHeight: alturaLinha + GAP_LINHAS,
  })
  const onMoverRef = useRef(onMover)
  // Refs atualizados em efeito (não durante o render), regra react-hooks/refs.
  useEffect(() => {
    onMoverRef.current = onMover
  })

  const registrarAlturaLinha = useCallback((altura: number) => {
    setAlturaLinha((atual) => (Math.abs(atual - altura) < 2 ? atual : altura))
  }, [])

  const mover = useCallback((_id: string, de: number, para: number) => {
    onMoverRef.current(de, para)
  }, [])

  const { dropProviderRef } = lista

  return (
    <Ctx.Provider value={{ ...lista, onMover: mover, registrarAlturaLinha }}>
      <DropProvider ref={dropProviderRef}>{children}</DropProvider>
    </Ctx.Provider>
  )
}

/** Linha da fase: long-press arrasta (a lib anima posição + segue o dedo);
 *  toque curto passa para os filhos (editar/remover). */
export function FaseLinhaArrastavel({
  chave,
  indice,
  children,
}: {
  chave: string
  indice: number
  children: ReactNode
}) {
  const { getItemProps, onMover, registrarAlturaLinha } = useFaseListaDrag()
  const { animatedStyle, panGestureHandler, isMoving } = useSortable({
    ...getItemProps({ id: chave }, indice),
    onMove: onMover,
  })

  return (
    <GestureDetector gesture={panGestureHandler}>
      <Animated.View
        style={[animatedStyle, isMoving && s.arrastando]}
        onLayout={(e) => registrarAlturaLinha(e.nativeEvent.layout.height)}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  )
}

const s = StyleSheet.create({
  arrastando: {
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
})
