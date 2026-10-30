/**
 * Reordering DnD of the phase list (pipeline form) through
 * react-native-reanimated-dnd: `useSortableList` manages the list (positions,
 * ScrollView auto-scroll) and each row uses `useSortable`. The card leaves its
 * own position following the finger (animated by the lib, on the UI thread) and
 * the others slide LIVE to make room — releasing commits nothing, the order was
 * already applied during the drag through onMove.
 *
 * Rows are identified by a stable `rowKey`: reordering does NOT unmount
 * components (which would kill the active gesture) — React only changes the order.
 *
 * The form applies it on the main ScrollView: ref={scrollViewRef},
 * onScroll={handleScroll}, onScrollEndDrag/MomentumScrollEnd={handleScrollEnd}
 * and minHeight={contentHeight} in the contentContainerStyle.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { StyleSheet } from 'react-native'
import { GestureDetector } from 'react-native-gesture-handler'
import Animated from 'react-native-reanimated'
import { DropProvider, useSortable, useSortableList } from 'react-native-reanimated-dnd'
import type { UseSortableListReturn } from 'react-native-reanimated-dnd'

/** Gap of the phase container in the form (gap: 6) — the sortable step is the
 *  row height plus the gap. */
const ROW_GAP = 6
/** Initial height before the first measurement (the row's onLayout). */
const INITIAL_HEIGHT = 56

interface PhaseListDragContext extends UseSortableListReturn<{ id: string }> {
  /** The lib's onMove: (id, from, to) — forwards to the form. */
  onMove: (id: string, from: number, to: number) => void
  /** Measurement of the first row (uniform heights) → the sortable's itemHeight. */
  registerRowHeight: (height: number) => void
}

const Ctx = createContext<PhaseListDragContext | null>(null)

export function usePhaseListDrag(): PhaseListDragContext {
  const value = useContext(Ctx)
  if (!value) throw new Error('usePhaseListDrag outside the PhaseListDragProvider')
  return value
}

export function PhaseListDragProvider({
  phases,
  onMove,
  children,
}: {
  /** Phases in the CURRENT order (only the keys matter to the lib). */
  phases: { rowKey: string }[]
  /** Reordering asked for during the drag: move the phase from `from` to `to`. */
  onMove: (from: number, to: number) => void
  children: ReactNode
}) {
  const [rowHeight, setRowHeight] = useState(INITIAL_HEIGHT)
  const data = useMemo(() => phases.map((p) => ({ id: p.rowKey })), [phases])
  const list = useSortableList({
    data,
    itemHeight: rowHeight + ROW_GAP,
  })
  const onMoveRef = useRef(onMove)
  // Refs updated in an effect (not during the render), react-hooks/refs rule.
  useEffect(() => {
    onMoveRef.current = onMove
  })

  const registerRowHeight = useCallback((height: number) => {
    setRowHeight((current) => (Math.abs(current - height) < 2 ? current : height))
  }, [])

  const move = useCallback((_id: string, from: number, to: number) => {
    onMoveRef.current(from, to)
  }, [])

  const { dropProviderRef } = list

  return (
    <Ctx.Provider value={{ ...list, onMove: move, registerRowHeight }}>
      <DropProvider ref={dropProviderRef}>{children}</DropProvider>
    </Ctx.Provider>
  )
}

/** Phase row: long-press drags (the lib animates the position and follows the
 *  finger); a short tap goes through to the children (edit/remove). */
export function DraggablePhaseRow({
  rowKey,
  index,
  children,
}: {
  rowKey: string
  index: number
  children: ReactNode
}) {
  const { getItemProps, onMove, registerRowHeight } = usePhaseListDrag()
  const { animatedStyle, panGestureHandler, isMoving } = useSortable({
    ...getItemProps({ id: rowKey }, index),
    onMove,
  })

  return (
    <GestureDetector gesture={panGestureHandler}>
      <Animated.View
        style={[animatedStyle, isMoving && s.dragging]}
        onLayout={(e) => registerRowHeight(e.nativeEvent.layout.height)}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  )
}

const s = StyleSheet.create({
  dragging: {
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
})
