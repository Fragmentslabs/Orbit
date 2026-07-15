import { View, Text, Pressable, ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Palette, ArrowLeft, Sun, Moon, Monitor } from 'lucide-react-native'
import { useState } from 'react'
import { cn } from '~/lib/utils'

type ThemeOption = 'light' | 'dark' | 'system'

const THEME_OPTIONS: { value: ThemeOption; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Claro', icon: Sun },
  { value: 'dark', label: 'Escuro', icon: Moon },
  { value: 'system', label: 'Sistema', icon: Monitor },
]

export default function ThemeScreen() {
  const router = useRouter()
  const [current, setCurrent] = useState<ThemeOption>('system')

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center px-4 py-3 border-b border-border">
        <Pressable onPress={() => router.back()} className="p-1 -ml-1">
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <Text className="flex-1 text-base font-semibold text-foreground text-center mr-6">
          Tema
        </Text>
      </View>
      <ScrollView className="flex-1">
        <View className="p-4 gap-2">
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon
            const isActive = current === option.value
            return (
              <Pressable
                key={option.value}
                onPress={() => setCurrent(option.value)}
                className={cn(
                  'flex-row items-center gap-3 px-4 py-3 rounded-lg',
                  isActive ? 'bg-accent border border-primary/30' : 'bg-card border border-border',
                )}
              >
                <Icon size={20} className={isActive ? 'text-primary' : 'text-muted-foreground'} />
                <Text
                  className={cn(
                    'text-sm flex-1',
                    isActive ? 'text-foreground font-medium' : 'text-foreground',
                  )}
                >
                  {option.label}
                </Text>
                {isActive && <Text className="text-xs text-primary">✓</Text>}
              </Pressable>
            )
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
