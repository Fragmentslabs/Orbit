import { Animated } from 'react-native'

export const DRAWER_WIDTH = 308

/** Duração da transição abrir/fechar do drawer. */
const DRAWER_DURATION = 250

/** Valores compartilhados entre o Sidebar (que os renderiza) e o gesto de
 *  swipe (que os arrasta com o dedo) — o drawer é único na árvore, então
 *  viver em escopo de módulo evita prop drilling pelo layout. */
export const drawerTranslateX = new Animated.Value(-DRAWER_WIDTH)
export const backdropOpacity = new Animated.Value(0)

/** Posiciona o drawer instantaneamente (durante o arraste). */
export function setDrawerOffset(offset: number) {
  const clamped = Math.min(0, Math.max(-DRAWER_WIDTH, offset))
  drawerTranslateX.setValue(clamped)
  backdropOpacity.setValue((clamped + DRAWER_WIDTH) / DRAWER_WIDTH)
}

/** Anima o drawer até o estado aberto/fechado. */
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
