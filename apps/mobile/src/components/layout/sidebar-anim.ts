import { Easing, makeMutable, withTiming } from 'react-native-reanimated'

export const DRAWER_WIDTH = 308

/** Values shared between the Sidebar (which renders them) and the swipe
 *  gesture (which drags them with the finger) — the drawer is unique in the
 *  tree, so living in module scope avoids prop drilling through the layout.
 *  They are Reanimated shared values: the gesture writes them from the UI
 *  thread and the drawer reads them in useAnimatedStyle, so the drag and the
 *  release animation never depend on the JS thread. */
export const drawerTranslateX = makeMutable(-DRAWER_WIDTH)
export const backdropOpacity = makeMutable(0)

/** Positions the drawer instantly (during the drag). Runs on the UI thread. */
export function setDrawerOffset(offset: number) {
  'worklet'
  const clamped = Math.min(0, Math.max(-DRAWER_WIDTH, offset))
  drawerTranslateX.value = clamped
  backdropOpacity.value = (clamped + DRAWER_WIDTH) / DRAWER_WIDTH
}

/** Animates the drawer to the open/closed state. A worklet, so the gesture can
 *  start the transition on the UI thread in the same frame the finger lifts.
 *  The duration follows the distance left, so a second call mid-flight (the
 *  Sidebar effect re-issuing the same target after the store change) keeps the
 *  same pace instead of adding a fixed pause. */
export function animateDrawer(open: boolean) {
  'worklet'
  const target = open ? 0 : -DRAWER_WIDTH
  const distance = Math.abs(target - drawerTranslateX.value)
  const duration = Math.max(110, Math.min(240, distance * 1.2))
  const timing = { duration, easing: Easing.out(Easing.cubic) }
  drawerTranslateX.value = withTiming(target, timing)
  backdropOpacity.value = withTiming(open ? 1 : 0, timing)
}
