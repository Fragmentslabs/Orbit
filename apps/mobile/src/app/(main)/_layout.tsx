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
            <Stack.Screen name="search" />
            <Stack.Screen name="memories" />
            <Stack.Screen name="media" />

            <Stack.Screen name="rotinas/index" />
            <Stack.Screen name="rotinas/nova" />
            <Stack.Screen name="rotinas/[id]" />
            <Stack.Screen name="rotinas/editar/[id]" />

            <Stack.Screen name="esteira/index" />
            <Stack.Screen name="esteira/nova" />
            <Stack.Screen name="esteira/[id]/index" />
            <Stack.Screen name="esteira/[id]/editar" />
            <Stack.Screen name="esteira/[id]/task/nova" />
            <Stack.Screen name="esteira/[id]/task/[taskId]" />

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
            <Stack.Screen name="about" />
          </Stack>
        </View>

        {isDesktop && rightPanelOpen && <RightPanel />}
      </View>

      <Sidebar />
    </View>
  )
}
