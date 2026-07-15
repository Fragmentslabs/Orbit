import { useEffect, useState } from 'react'
import { View, Text, Pressable, Animated, ScrollView } from 'react-native'
import { useRouter } from 'expo-router'
import {
  MessageSquare,
  BrainCircuit,
  Box,
  BarChart3,
  Puzzle,
  Settings,
  Palette,
  LogOut,
  Plus,
} from 'lucide-react-native'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useConnectionStore } from '~/stores/connection-store'
import { cn } from '~/lib/utils'

const DRAWER_WIDTH = 280

type NavItem = {
  label: string
  icon: typeof MessageSquare
  view?: string
  codeOnly?: boolean
  action?: () => void
}

export function Sidebar() {
  const router = useRouter()
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen)
  const mode = useWorkspaceStore((s) => s.mode)
  const closeSidebar = useWorkspaceStore((s) => s.closeSidebar)
  const setMode = useWorkspaceStore((s) => s.setMode)
  const disconnect = useConnectionStore((s) => s.disconnect)
  const clearSavedConfig = useConnectionStore((s) => s.clearSavedConfig)

  const [slideAnim] = useState(() => new Animated.Value(-DRAWER_WIDTH))
  const [backdropAnim] = useState(() => new Animated.Value(0))

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: sidebarOpen ? 0 : -DRAWER_WIDTH,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(backdropAnim, {
        toValue: sidebarOpen ? 1 : 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start()
  }, [sidebarOpen, slideAnim, backdropAnim])

  const navigate = (path: string) => {
    closeSidebar()
    router.push(path as any)
  }

  const handleDisconnect = async () => {
    disconnect()
    await clearSavedConfig()
    closeSidebar()
    router.replace('/(connection)')
  }

  const handleNewChat = () => {
    closeSidebar()
    // Placeholder: creates a new chat session
    // For now, navigates to home
    router.push('/(main)')

  }

  const topItems: NavItem[] = [
    {
      label: mode === 'chat' ? 'Novo Chat' : 'Nova Sessão',
      icon: Plus,
      action: handleNewChat,
    },
    {
      label: mode === 'chat' ? 'Chats' : 'Sessões',
      icon: MessageSquare,
      view: 'home',
    },
    { label: 'Memórias', icon: BrainCircuit, view: 'memories' },
    { label: 'Modelos', icon: Box, view: 'models' },
    { label: 'Uso e Limites', icon: BarChart3, view: 'usage' },
    { label: 'Ferramentas', icon: Puzzle, view: 'tools', codeOnly: true },
  ]

  const footerItems: NavItem[] = [
    { label: 'Configurações', icon: Settings, view: 'settings' },
    { label: 'Tema', icon: Palette, view: 'theme' },
    { label: 'Desconectar', icon: LogOut, action: handleDisconnect },
  ]

  const filteredTopItems = topItems.filter((item) => !item.codeOnly || mode === 'code')

  return (
    <>
      {/* Backdrop */}
      <Animated.View
        pointerEvents={sidebarOpen ? 'auto' : 'none'}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.4)',
          opacity: backdropAnim,
          zIndex: 50,
        }}
      >
        <Pressable style={{ flex: 1 }} onPress={closeSidebar} />
      </Animated.View>

      {/* Drawer */}
      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: DRAWER_WIDTH,
          backgroundColor: 'hsl(var(--background))',
          borderRightWidth: 1,
          borderRightColor: 'hsl(var(--border))',
          transform: [{ translateX: slideAnim }],
          zIndex: 51,
          elevation: 10,
        }}
      >
        <View style={{ flex: 1 }}>
          {/* Mode Tabs */}
          <View className="flex-row border-b border-border">
            <ModeTab label="Chat" active={mode === 'chat'} onPress={() => setMode('chat')} />
            <ModeTab label="Código" active={mode === 'code'} onPress={() => setMode('code')} />
          </View>

          {/* Navigation Items */}
          <ScrollView className="flex-1 pt-2">
            {filteredTopItems.map((item) => (
              <SidebarItem
                key={item.label}
                icon={item.icon}
                label={item.label}
                onPress={() => {
                  if (item.action) {
                    item.action()
                  } else if (item.view) {
                    navigate(item.view === 'home' ? '/(main)' : `/(main)/${item.view}`)
                  }
                }}
              />
            ))}
          </ScrollView>

          {/* Footer */}
          <View className="border-t border-border pt-2 pb-4">
            {footerItems.map((item) => (
              <SidebarItem
                key={item.label}
                icon={item.icon}
                label={item.label}
                onPress={() => {
                  if (item.action) {
                    item.action()
                  } else if (item.view) {
                    navigate(`/(main)/${item.view}`)
                  }
                }}
                destructive={item.label === 'Desconectar'}
              />
            ))}
          </View>
        </View>
      </Animated.View>
    </>
  )
}

function ModeTab({
  label,
  active,
  onPress,
}: {
  label: string
  active: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'flex-1 py-3 items-center',
        active ? 'border-b-2 border-primary' : 'border-b-2 border-transparent',
      )}
    >
      <Text
        className={cn(
          'text-sm font-medium',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {label}
      </Text>
    </Pressable>
  )
}

function SidebarItem({
  icon: Icon,
  label,
  onPress,
  destructive,
}: {
  icon: typeof MessageSquare
  label: string
  onPress: () => void
  destructive?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 px-4 py-2.5 active:bg-accent"
    >
      <Icon size={18} className={destructive ? 'text-destructive' : 'text-muted-foreground'} />
      <Text
        className={cn(
          'text-sm',
          destructive ? 'text-destructive font-medium' : 'text-foreground',
        )}
      >
        {label}
      </Text>
    </Pressable>
  )
}
