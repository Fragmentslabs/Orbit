import { View } from 'react-native'
import { Stack } from 'expo-router'
import { Sidebar } from '~/components/layout/Sidebar'
import { RightPanel } from '~/components/chat/RightPanel'
import { useBreakpoint } from '~/components/layout/ResponsiveContainer'
import { useWorkspaceStore } from '~/stores/workspace-store'

const SIDEBAR_WIDTH = 280

export default function MainLayout() {
  const breakpoint = useBreakpoint()
  const isDesktop = breakpoint === 'desktop'
  const rightPanelOpen = useWorkspaceStore((s) => s.rightPanelOpen)
  const sidebarPinned = useWorkspaceStore((s) => s.sidebarPinned)

  return (
    <View className="flex-1 bg-background">
      <View className="flex-1 flex-row">
        {/* Content area - offset when sidebar pinned on desktop */}
        <View
          className="flex-1"
          style={isDesktop && sidebarPinned ? { marginLeft: SIDEBAR_WIDTH } : undefined}
        >
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="chat/[id]" />
            <Stack.Screen name="memories" />

            <Stack.Screen name="usage" />
            <Stack.Screen name="tools" />
            <Stack.Screen name="settings" />
            <Stack.Screen name="theme" />
          </Stack>
        </View>

        {isDesktop && rightPanelOpen && <RightPanel />}
      </View>

      <Sidebar />
    </View>
  )
}
