import { Animated } from 'react-native'

export const DRAWER_WIDTH = 308

/** Duration of the open/close transition of the drawer. */
const DRAWER_DURATION = 250

/** Values shared between the Sidebar (which renders them) and the swipe
 *  gesture (which drags them with the finger) — the drawer is unique in the
 *  tree, so living in module scope avoids prop drilling through the layout. */
export const drawerTranslateX = new Animated.Value(-DRAWER_WIDTH)
export const backdropOpacity = new Animated.Value(0)

/** Positions the drawer instantly (during the drag). */
export function setDrawerOffset(offset: number) {
  const clamped = Math.min(0, Math.max(-DRAWER_WIDTH, offset))
  drawerTranslateX.setValue(clamped)
  backdropOpacity.setValue((clamped + DRAWER_WIDTH) / DRAWER_WIDTH)
}

/** Animates the drawer to the open/closed state. */
export function animateDrawer(open: boolean) {
  Animated.parallel([
    Animated.timing(drawerTranslateX, {
      toValue: open ? 0 : -DRAWER_WIDTH,
      duration: DRAWER_DURATION,
      useNativeDriver: true,
    }),
    Animated.timing(backdropOpacity, {
      toValue: open ? 1 : 0,
      duration: DRAWER_DURATION,
      useNativeDriver: true,
    }),
  ]).start()
}
