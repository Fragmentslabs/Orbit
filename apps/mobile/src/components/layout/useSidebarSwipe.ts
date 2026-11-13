/* eslint-disable react-hooks/immutability -- assigning `.value` on a shared
 * value IS the Reanimated API. The writes happen inside worklets ('worklet'),
 * which run on the UI thread outside the React render cycle; the rule forbids
 * modifying any hook return value and cannot see that boundary. */
import { useMemo } from 'react'
import { Gesture } from 'react-native-gesture-handler'
import { runOnJS, runOnUI, useSharedValue } from 'react-native-reanimated'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { DRAWER_WIDTH, animateDrawer, setDrawerOffset } from './sidebar-anim'

/** Horizontal displacement that hands the touch to the drawer. */
const MOVE_THRESHOLD = 36

/** The drag only arms when it is this many times more horizontal than vertical.
 *  A scroll — even a fast one, with the sideways drift of a thumb — always has
 *  a vertical component bigger than that, so it keeps the touch. */
const HORIZONTAL_RATIO = 3

/** Vertical displacement that gives the touch back to the content. */
const VERTICAL_SLOP = 14

/** Fraction of the drawer width that decides open/close on release. */
const SETTLE_RATIO = 0.35

/** Velocity (px/s) that decides open/close regardless of the distance. A pan
 *  of the gesture handler reports points per second (the old PanResponder
 *  reported per millisecond). */
const FLING_VELOCITY = 350

function clampOffset(offset: number): number {
  'worklet'
  return Math.min(0, Math.max(-DRAWER_WIDTH, offset))
}

/** Syncs the store with the swipe result. The drawer was already animated on
 *  the UI thread at release; the Sidebar effect re-issues the same target, which
 *  is idempotent — the store must never diverge from what is on screen. */
function commit(open: boolean) {
  const store = useWorkspaceStore.getState()
  if (open === store.sidebarOpen) return
  if (open) store.openSidebar()
  else store.closeSidebar()
}

/** Puts the drawer back where the store says it is, after a cancelled gesture. */
function restore() {
  runOnUI(animateDrawer)(useWorkspaceStore.getState().sidebarOpen)
}

/**
 * Dragging the screen to the right opens the sidebar; with it open, dragging to
 * the left closes it. The drag works anywhere on the screen and the drawer
 * follows the finger.
 *
 * The gesture is a NATIVE pan (react-native-gesture-handler) attached to the
 * layout's root view, with MANUAL activation: the touch only becomes a drawer
 * pull when the movement is clearly horizontal (36px, three times more
 * horizontal than vertical). Letting the platform decide with
 * activeOffsetX/failOffsetY was not enough — on a fast scroll with the sideways
 * drift of a thumb, whichever threshold the platform evaluates first wins, and
 * the drawer was arming in the middle of the chat scroll. Here the decision is
 * made once, from the whole movement.
 */
export function useSidebarSwipe(enabled = true) {
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen)
  // Only to know, at the end, whether the drawer had already taken the touch.
  const tookTouch = useSharedValue(false)
  // Displacement at the moment the pan activated: the drawer follows the finger
  // from there, so it does not jump the threshold distance on activation.
  const activationX = useSharedValue(0)
  // Where the finger touched down, in window coordinates.
  const touchX = useSharedValue(0)
  const touchY = useSharedValue(0)

  // Rebuilt when the drawer state changes: the worklets capture it, and it only
  // happens on open/close, never in the middle of a drag.
  return useMemo(() => {
    if (!enabled) return Gesture.Pan().enabled(false)

    // Where the drawer was when the drag started: closed is fully off screen.
    const startOffset = sidebarOpen ? 0 : -DRAWER_WIDTH

    return Gesture.Pan()
      .manualActivation(true)
      .maxPointers(1)
      .onTouchesDown((event) => {
        'worklet'
        const touch = event.allTouches[0]
        if (!touch) return
        touchX.value = touch.absoluteX
        touchY.value = touch.absoluteY
        tookTouch.value = false
      })
      .onTouchesMove((event, manager) => {
        'worklet'
        const touch = event.allTouches[0]
        if (!touch) return
        const dx = touch.absoluteX - touchX.value
        const dy = touch.absoluteY - touchY.value
        const horizontal =
          Math.abs(dx) >= MOVE_THRESHOLD && Math.abs(dx) >= Math.abs(dy) * HORIZONTAL_RATIO
        // A closed drawer only opens (drag right); an open one only closes.
        const pullsDrawer = sidebarOpen ? dx < 0 : dx > 0

        if (horizontal) {
          if (pullsDrawer) {
            tookTouch.value = true
            manager.activate()
          } else {
            manager.fail()
          }
        } else if (Math.abs(dy) >= VERTICAL_SLOP) {
          // Not horizontal and the finger is already going up/down: a scroll.
          manager.fail()
        }
      })
      .onStart((event) => {
        'worklet'
        activationX.value = event.translationX
      })
      .onUpdate((event) => {
        'worklet'
        setDrawerOffset(startOffset + event.translationX - activationX.value)
      })
      .onEnd((event) => {
        'worklet'
        const offset = clampOffset(startOffset + event.translationX - activationX.value)
        const progress = (offset + DRAWER_WIDTH) / DRAWER_WIDTH
        const shouldOpen =
          Math.abs(event.velocityX) > FLING_VELOCITY ? event.velocityX > 0 : progress > SETTLE_RATIO
        animateDrawer(shouldOpen)
        runOnJS(commit)(shouldOpen)
      })
      .onFinalize((_event, success) => {
        'worklet'
        // Cancelled without a normal end: the drawer goes back to the store state.
        if (tookTouch.value && !success) runOnJS(restore)()
        tookTouch.value = false
      })
  }, [enabled, sidebarOpen, tookTouch, activationX, touchX, touchY])
}
