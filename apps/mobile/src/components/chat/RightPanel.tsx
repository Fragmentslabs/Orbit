import { View, Text, Pressable, ScrollView } from 'react-native'
import { useState } from 'react'
import { Globe, Diff, Terminal, Folder, X } from 'lucide-react-native'
import { cn } from '~/lib/utils'
import { useWorkspaceStore } from '~/stores/workspace-store'

type Tab = 'browser' | 'diff' | 'terminal' | 'folders'

const tabs: { key: Tab; label: string; icon: typeof Globe }[] = [
  { key: 'browser', label: 'Navegador', icon: Globe },
  { key: 'diff', label: 'Diff', icon: Diff },
  { key: 'terminal', label: 'Terminal', icon: Terminal },
  { key: 'folders', label: 'Pastas', icon: Folder },
]

export function RightPanel() {
  const [activeTab, setActiveTab] = useState<Tab>('browser')
  const rightPanelOpen = useWorkspaceStore((s) => s.rightPanelOpen)
  const toggleRightPanel = useWorkspaceStore((s) => s.toggleRightPanel)

  if (!rightPanelOpen) return null

  return (
    <View className="w-80 border-l border-border bg-background">
      {/* Tab bar */}
      <View className="flex-row items-center border-b border-border">
        {tabs.map(({ key, label, icon: Icon }) => (
          <Pressable
            key={key}
            onPress={() => setActiveTab(key)}
            className={cn(
              'flex-row items-center gap-1 px-3 py-2.5 border-b-2',
              activeTab === key
                ? 'border-primary'
                : 'border-transparent',
            )}
          >
            <Icon size={14} className={activeTab === key ? 'text-foreground' : 'text-muted-foreground'} />
            <Text
              className={cn(
                'text-xs',
                activeTab === key ? 'text-foreground font-medium' : 'text-muted-foreground',
              )}
            >
              {label}
            </Text>
          </Pressable>
        ))}
        <View className="flex-1" />
        <Pressable onPress={toggleRightPanel} className="p-2 mr-1">
          <X size={16} className="text-muted-foreground" />
        </Pressable>
      </View>

      {/* Content */}
      <ScrollView className="flex-1 p-4">
        {activeTab === 'browser' && (
          <Text className="text-sm text-muted-foreground">Navegador não conectado.</Text>
        )}
        {activeTab === 'diff' && (
          <Text className="text-sm text-muted-foreground">Nenhuma alteração detectada.</Text>
        )}
        {activeTab === 'terminal' && (
          <Text className="text-sm text-muted-foreground">Terminal desconectado.</Text>
        )}
        {activeTab === 'folders' && (
          <Text className="text-sm text-muted-foreground">Nenhuma pasta aberta.</Text>
        )}
      </ScrollView>
    </View>
  )
}
