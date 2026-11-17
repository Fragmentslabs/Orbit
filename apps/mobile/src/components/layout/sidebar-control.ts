import { runOnUI } from 'react-native-reanimated'

import { useWorkspaceStore } from '~/stores/workspace-store'

import { animateDrawer } from './sidebar-anim'

/**
 * Opens and closes the drawer.
 *
 * The drawer has two states that can drift apart: the store flag and the position on screen
 * (the swipe writes the position on the UI thread, the store is synced afterwards). The old
 * path only moved the drawer when the flag CHANGED, so a close request while the flag already
 * said "closed" — the backdrop tap after a swipe, picking a chat after a reload — did nothing and
 * the drawer stayed open. Here the animation always runs, whatever the flag says.
 */
export function openDrawer() {
  useWorkspaceStore.getState().openSidebar()
  runOnUI(animateDrawer)(true)
}

export function closeDrawer() {
  useWorkspaceStore.getState().closeSidebar()
  runOnUI(animateDrawer)(false)
}
