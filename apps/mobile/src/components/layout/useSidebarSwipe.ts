import { useState } from 'react'
import { PanResponder } from 'react-native'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { DRAWER_WIDTH, animateDrawer, setDrawerOffset } from './sidebar-anim'

/** Faixa a partir da borda esquerda que reconhece o swipe de abertura. */
const EDGE_WIDTH = 28

/** Deslocamento mínimo antes de assumir o toque de um filho. */
const MOVE_THRESHOLD = 8

/** O gesto só é horizontal se dx dominar dy — deixa o scroll vertical passar. */
const HORIZONTAL_RATIO = 1.5

/** Fração da largura do drawer que decide abrir/fechar ao soltar. */
const SETTLE_RATIO = 0.4

/** Velocidade (px/ms) que decide abrir/fechar independente da distância. */
const FLING_VELOCITY = 0.35

/** Posição do drawer quando o arraste começou. Só existe um gesto por vez,
 *  então viver no módulo evita ler ref durante o render. */
let startOffset = 0

/**
 * Swipe para a direita a partir da borda esquerda abre o sidebar; com ele
 * aberto, swipe para a esquerda fecha. O drawer acompanha o dedo.
 *
 * Os handlers devem ser espalhados na View que envolve conteúdo + sidebar:
 * a captura acontece na fase de captura do responder, então listas e botões
 * continuam recebendo toques normalmente.
 */
export function useSidebarSwipe(enabled = true) {
  // Criado uma vez; o estado atual vem do store via getState() dentro dos
  // handlers, então não há closure obsoleta nem ref lida durante o render.
  const [responder] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_evt, g) => {
        if (Math.abs(g.dx) < MOVE_THRESHOLD) return false
        if (Math.abs(g.dx) < Math.abs(g.dy) * HORIZONTAL_RATIO) return false
        if (useWorkspaceStore.getState().sidebarOpen) return g.dx < 0
        return g.dx > 0 && g.moveX - g.dx <= EDGE_WIDTH
      },
      onPanResponderGrant: () => {
        startOffset = useWorkspaceStore.getState().sidebarOpen ? 0 : -DRAWER_WIDTH
      },
      onPanResponderMove: (_evt, g) => {
        setDrawerOffset(startOffset + g.dx)
      },
      onPanResponderRelease: (_evt, g) => {
        const offset = Math.min(0, Math.max(-DRAWER_WIDTH, startOffset + g.dx))
        const progress = (offset + DRAWER_WIDTH) / DRAWER_WIDTH
        const shouldOpen = Math.abs(g.vx) > FLING_VELOCITY ? g.vx > 0 : progress > SETTLE_RATIO

        const store = useWorkspaceStore.getState()
        if (shouldOpen === store.sidebarOpen) {
          // Estado não muda: o efeito do Sidebar não roda, anima aqui.
          animateDrawer(shouldOpen)
        } else if (shouldOpen) {
          store.openSidebar()
        } else {
          store.closeSidebar()
        }
      },
      onPanResponderTerminate: () => {
        animateDrawer(useWorkspaceStore.getState().sidebarOpen)
      },
      onPanResponderTerminationRequest: () => false,
    })
  )

  return enabled ? responder.panHandlers : {}
}
