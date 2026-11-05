import { View } from 'react-native'
import { Stack } from 'expo-router'
import { Sidebar } from '~/components/layout/Sidebar'
import { RightPanel } from '~/components/chat/RightPanel'
import { MemorySheet } from '~/components/memories/MemorySheet'
import { useBreakpoint } from '~/components/layout/ResponsiveContainer'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useSidebarSwipe } from '~/components/layout/useSidebarSwipe'

const SIDEBAR_WIDTH = 280

export default function MainLayout() {
  const breakpoint = useBreakpoint()
  const isDesktop = breakpoint === 'desktop'
  const rightPanelOpen = useWorkspaceStore((s) => s.rightPanelOpen)
  const sidebarPinned = useWorkspaceStore((s) => s.sidebarPinned)
  // Swipe from the left edge opens the drawer; on desktop it is already fixed/hover.
  const swipeHandlers = useSidebarSwipe(!isDesktop)

  return (
    <View className="flex-1 bg-background" {...swipeHandlers}>
      <View className="flex-1 flex-row">
        {/* Content area - offset when sidebar pinned on desktop */}
        <View
          className="flex-1"
          style={isDesktop && sidebarPinned ? { marginLeft: SIDEBAR_WIDTH } : undefined}
        >
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="chat/[id]" />
            <Stack.Screen name="search" />
            <Stack.Screen name="memories" />
            <Stack.Screen name="media" />

            <Stack.Screen name="routines/index" />
            <Stack.Screen name="routines/new" />
            <Stack.Screen name="routines/[id]" />
            <Stack.Screen name="routines/[id]/edit" />

            <Stack.Screen name="pipeline/index" />
            <Stack.Screen name="pipeline/new" />
            <Stack.Screen name="pipeline/[id]/index" />
            <Stack.Screen name="pipeline/[id]/edit" />
            <Stack.Screen name="pipeline/[id]/history" />
            <Stack.Screen name="pipeline/[id]/task/plan" />
            <Stack.Screen name="pipeline/[id]/task/new" />
            <Stack.Screen name="pipeline/[id]/task/[taskId]" />

            <Stack.Screen name="usage" />
            <Stack.Screen name="tools" />
            <Stack.Screen name="settings" />
            <Stack.Screen name="providers" />
            <Stack.Screen name="preferences" />
            <Stack.Screen name="notifications" />
            <Stack.Screen name="language" />
            <Stack.Screen name="howto" />
            <Stack.Screen name="appearance" />
            <Stack.Screen name="modes" />
            <Stack.Screen name="rotations/index" />
            <Stack.Screen name="rotations/[id]" />
            <Stack.Screen name="about" />
          </Stack>
        </View>

        {isDesktop && rightPanelOpen && <RightPanel />}
      </View>

      <Sidebar />

      {/* Sheet of the cited memory: mounted ONCE for the whole app (like the
          Sidebar) — chips from any screen only point the id in the store. If it
          lived inside the ChatScreen, a chip on the Memories screen would open
          nothing; two mounted copies would give two modals for the same state. */}
      <MemorySheet />
    </View>
  )
}
