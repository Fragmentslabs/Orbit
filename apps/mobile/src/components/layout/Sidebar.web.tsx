import { useEffect, useState, useRef, useCallback } from 'react'
import { View, Text, Pressable, ScrollView, Animated } from 'react-native'
import { useRouter } from 'expo-router'
import {
  MessageSquare,
  BrainCircuit,
  BarChart3,
  Puzzle,
  Settings,
  Palette,
  LogOut,
  Plus,
  Pin,
  PinOff,
} from 'lucide-react-native'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useConnectionStore } from '~/stores/connection-store'
import { cn } from '~/lib/utils'

const SIDEBAR_WIDTH = 280

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
  const sidebarPinned = useWorkspaceStore((s) => s.sidebarPinned)
  const mode = useWorkspaceStore((s) => s.mode)
  const closeSidebar = useWorkspaceStore((s) => s.closeSidebar)
  const setMode = useWorkspaceStore((s) => s.setMode)
  const pinSidebar = useWorkspaceStore((s) => s.pinSidebar)
  const disconnect = useConnectionStore((s) => s.disconnect)
  const clearSavedConfig = useConnectionStore((s) => s.clearSavedConfig)

  const [slideAnim] = useState(() => new Animated.Value(sidebarPinned ? 0 : -SIDEBAR_WIDTH))
  const [hovering, setHovering] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isVisible = sidebarPinned || sidebarOpen || hovering

  useEffect(() => {
    Animated.timing(slideAnim, {
      toValue: isVisible ? 0 : -SIDEBAR_WIDTH,
      duration: 200,
      useNativeDriver: true,
    }).start()
  }, [isVisible, slideAnim])

  const handleHoverEnter = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHovering(true), 300)
  }, [])

  const handleHoverLeave = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (!sidebarPinned) {
      hoverTimer.current = setTimeout(() => {
        setHovering(false)
        closeSidebar()
      }, 200)
    }
  }, [sidebarPinned, closeSidebar])

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
      {/* Hover target area (left edge) */}
      <Pressable
        onHoverIn={handleHoverEnter}
        onHoverOut={handleHoverLeave}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: 12,
          zIndex: 60,
        }}
      />

      {/* Backdrop when floating (not pinned) */}
      {(sidebarOpen || hovering) && !sidebarPinned && (
        <Pressable
          onPress={() => {
            setHovering(false)
            closeSidebar()
          }}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.3)',
            zIndex: 60,
          }}
        />
      )}

      {/* Sidebar panel */}
      <Pressable
        onHoverIn={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current) }}
        onHoverOut={handleHoverLeave}
        style={{ position: 'absolute', top: 0, left: 0, bottom: 0, zIndex: 61 }}
      >
        <Animated.View
          style={{
            width: SIDEBAR_WIDTH,
            flex: 1,
            backgroundColor: 'var(--background)',
            borderRightWidth: 1,
            borderRightColor: 'var(--border-color)',
            transform: [{ translateX: slideAnim }],
            elevation: 10,
            shadowColor: '#000',
            shadowOffset: { width: 4, height: 0 },
            shadowOpacity: 0.15,
            shadowRadius: 12,
          }}
        >
          <View className="flex-1">
            {/* Header with pin */}
            <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
              <Text className="text-sm font-semibold text-foreground">Navegação</Text>
              <Pressable
                onPress={() => pinSidebar(!sidebarPinned)}
                className="p-1 rounded-md hover:bg-accent"
              >
                {sidebarPinned ? (
                  <PinOff size={16} className="text-muted-foreground" />
                ) : (
                  <Pin size={16} className="text-muted-foreground" />
                )}
              </Pressable>
            </View>

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
      </Pressable>
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
      className="flex-row items-center gap-3 px-4 py-2.5 hover:bg-accent active:bg-accent"
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
