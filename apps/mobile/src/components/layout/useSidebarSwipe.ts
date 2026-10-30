import { useState } from 'react'
import { PanResponder } from 'react-native'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { DRAWER_WIDTH, animateDrawer, setDrawerOffset } from './sidebar-anim'

/** Band from the left edge that recognizes the opening swipe. */
const EDGE_WIDTH = 28

/** Minimum displacement before taking the touch from a child. */
const MOVE_THRESHOLD = 8

/** The gesture is only horizontal if dx dominates dy — lets the vertical scroll through. */
const HORIZONTAL_RATIO = 1.5

/** Fraction of the drawer width that decides open/close on release. */
const SETTLE_RATIO = 0.4

/** Velocity (px/ms) that decides open/close regardless of the distance. */
const FLING_VELOCITY = 0.35

/** Drawer position when the drag started. There is only one gesture at a
 *  time, so living in the module avoids reading a ref during render. */
let startOffset = 0

/**
 * Swipe to the right from the left edge opens the sidebar; with it
 * open, a swipe to the left closes it. The drawer follows the finger.
 *
 * The handlers should be spread on the View that wraps content + sidebar:
 * the capture happens in the responder capture phase, so lists and buttons
 * keep receiving touches normally.
 */
export function useSidebarSwipe(enabled = true) {
  // Created once; the current state comes from the store via getState() inside the
  // handlers, so there is no stale closure and no ref read during render.
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
          // State does not change: the Sidebar effect does not run, animate here.
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
