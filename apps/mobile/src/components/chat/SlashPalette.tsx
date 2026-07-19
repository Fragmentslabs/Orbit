import { useMemo, useState, useCallback, type ReactNode } from 'react'
import { View, Text, Pressable, ScrollView, Platform } from 'react-native'
import { Sparkles, Wrench, Layers, Zap, BrainCircuit } from 'lucide-react-native'
import { normalizeText } from '@orbit/shared'
import { SLASH_ACTION_COMMANDS } from '@orbit/shared'
import type { SlashCommand } from '~/hooks/useSlashCommands'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const GROUP_ORDER: SlashCommand['group'][] = ['Ações', 'Skills', 'MCP', 'Memória', 'Modos']

const GROUP_ICON: Record<SlashCommand['group'], typeof Sparkles> = {
  Modos: Wrench,
  Skills: Sparkles,
  MCP: Layers,
  Memória: BrainCircuit,
  Ações: Zap,
}

function matches(command: SlashCommand, query: string): boolean {
  if (!query) return true
  const haystack = normalizeText(
    [command.label, command.description ?? '', ...(command.keywords ?? [])].join(' '),
  )
  return query.split(' ').every((token) => haystack.includes(token))
}

const LITERAL_COMMANDS = ['/create-skill', '/document', ...SLASH_ACTION_COMMANDS.map((c) => c + ' ')]

interface SlashPaletteProps {
  value: string
  setText: (text: string) => void
  commands: SlashCommand[]
  children: ReactNode
}

export function SlashPalette({ value, setText, commands, children }: SlashPaletteProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const open = value.startsWith('/') && !LITERAL_COMMANDS.some((literal) => value.startsWith(literal))
  const query = open ? normalizeText(value.slice(1)) : ''
  const [selectedIndex, setSelectedIndex] = useState(0)

  const filtered = useMemo(() => {
    if (!open) return []
    return commands
      .filter((c) => matches(c, query))
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
  }, [commands, open, query])

  const groups = useMemo(() => {
    const map = new Map<SlashCommand['group'], SlashCommand[]>()
    for (const command of filtered) {
      const bucket = map.get(command.group) ?? []
      bucket.push(command)
      map.set(command.group, bucket)
    }
    return [...map.entries()]
  }, [filtered])

  const select = useCallback(
    (command: SlashCommand) => {
      command.run({ setText })
    },
    [setText],
  )

  if (!open || filtered.length === 0) return <>{children}</>

  return (
    <View style={{ position: 'relative' }}>
      <View
        style={{
          position: 'absolute',
          bottom: '100%',
          left: 0,
          right: 0,
          zIndex: 50,
          marginBottom: 8,
          maxHeight: 260,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: tokens.card,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.15,
          shadowRadius: 12,
          elevation: 8,
        }}
      >
        <ScrollView style={{ maxHeight: 260 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {groups.map(([group, items]) => {
            const Icon = GROUP_ICON[group]
            return (
              <View key={group}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    paddingHorizontal: 12,
                    paddingTop: 10,
                    paddingBottom: 4,
                  }}
                >
                  <Icon size={12} color={tokens.mutedForeground} />
                  <Text
                    style={{
                      fontSize: 10,
                      fontWeight: '600',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      color: tokens.mutedForeground,
                    }}
                  >
                    {group}
                  </Text>
                </View>
                {items.map((command) => (
                  <Pressable
                    key={command.id}
                    onPress={() => select(command)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      backgroundColor: pressed ? tokens.muted : 'transparent',
                    })}
                  >
                    <Text
                      style={{
                        fontWeight: '600',
                        fontSize: 13,
                        color: tokens.foreground,
                        flexShrink: 0,
                      }}
                    >
                      {command.label}
                    </Text>
                    {command.description && (
                      <Text
                        style={{
                          flex: 1,
                          fontSize: 11,
                          color: tokens.mutedForeground,
                        }}
                        numberOfLines={1}
                      >
                        {command.description}
                      </Text>
                    )}
                    {command.active !== undefined && (
                      <View
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 3,
                          backgroundColor: command.active ? '#22c55e' : tokens.mutedForeground + '4D',
                        }}
                      />
                    )}
                  </Pressable>
                ))}
              </View>
            )
          })}
        </ScrollView>
      </View>
      {children}
    </View>
  )
}
