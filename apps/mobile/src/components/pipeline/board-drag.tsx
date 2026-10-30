/**
 * Board drag & drop through react-native-reanimated-dnd: each task is a
 * Draggable (long-press via preDragDelay — a quick tap still opens the task and
 * a quick swipe still scrolls) and each section is a Droppable. The card leaves
 * its own position following the finger (animated by the lib, on the UI thread).
 *
 * Rules: a completed task never drags (dragDisabled); the destination
 * validation ("pending goes to any phase, whatever already started only moves
 * forward") stays with the board — the sections receive dropDisabled computed
 * from the dragged task.
 *
 * Auto-scroll: when the finger gets close to the viewport edges, the provider
 * scrolls the ScrollView and asks the lib to re-measure the zones
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

/** Payload of the DropProvider's onDragging (the type is inline in the lib). */
interface DragPayload {
  x: number
  y: number
  tx: number
  ty: number
  itemData: unknown
}

interface BoardDragContextValue {
  /** Board ScrollView ref (for the auto-scroll). */
  registerScrollRef: (ref: ScrollView | null) => void
  /** Viewport height (onLayout of the ScrollView). */
  registerViewport: (height: number) => void
  /** Scrolled offset (onScroll of the board) — the auto-scroll base. */
  registerScrollOffset: (offset: number) => void
  /** Task being dragged — the sections compute dropDisabled with it. */
  dragging: Task | null
}

const Ctx = createContext<BoardDragContextValue | null>(null)

export function useBoardDrag(): BoardDragContextValue {
  const value = useContext(Ctx)
  if (!value) throw new Error('useBoardDrag outside the BoardDragProvider')
  return value
}

const AUTOSCROLL_MARGIN = 90
const AUTOSCROLL_STEP = 10
const AUTOSCROLL_INTERVAL = 16

export function BoardDragProvider({ children }: { children: ReactNode }) {
  const [dragging, setDragging] = useState<Task | null>(null)
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

  const stopAutoScroll = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const handleDragging = useCallback(
    ({ y, ty }: DragPayload) => {
      const fingerY = y + ty
      const height = viewportRef.current
      if (!height || !scrollRef.current) return
      let direction: 1 | -1 | null = null
      if (fingerY < AUTOSCROLL_MARGIN) direction = -1
      else if (fingerY > height - AUTOSCROLL_MARGIN) direction = 1
      if (!direction) {
        stopAutoScroll()
        return
      }
      if (timerRef.current) return
      timerRef.current = setInterval(() => {
        offsetRef.current = Math.max(0, offsetRef.current + direction * AUTOSCROLL_STEP)
        scrollRef.current?.scrollTo({ y: offsetRef.current, animated: false })
        // The zones (Droppable) move with the scroll — the lib re-measures them.
        dropProviderRef.current?.requestPositionUpdate()
      }, AUTOSCROLL_INTERVAL)
    },
    [stopAutoScroll],
  )

  const registerScrollRef = useCallback((ref: ScrollView | null) => {
    scrollRef.current = ref
  }, [])

  const registerViewport = useCallback((height: number) => {
    viewportRef.current = height
  }, [])

  const registerScrollOffset = useCallback((offset: number) => {
    offsetRef.current = offset
  }, [])

  const handleDragStart = useCallback((data: Task) => {
    setDragging(data)
  }, [])

  const handleDragEnd = useCallback(() => {
    setDragging(null)
    stopAutoScroll()
  }, [stopAutoScroll])

  return (
    <Ctx.Provider value={{ registerScrollRef, registerViewport, registerScrollOffset, dragging }}>
      <DropProvider
        ref={dropProviderRef}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragging={handleDragging}
      >
        <View style={{ flex: 1 }}>{children}</View>
      </DropProvider>
    </Ctx.Provider>
  )
}

/** Card with long-press to drag. A short tap goes through to the children
 *  (open the task); a completed task never drags (dragDisabled). */
export function DraggableCard({ task, children }: { task: Task; children: ReactNode }) {
  const { animatedViewProps, gesture } = useDraggable({
    data: task,
    preDragDelay: 280,
    dragDisabled: task.status === 'completed',
  })

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View {...animatedViewProps} style={animatedViewProps.style}>
        {children}
      </Animated.View>
    </GestureDetector>
  )
}
