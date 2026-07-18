import { ScrollView, Pressable, Text } from 'react-native'
import { cn } from '~/lib/utils'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface SuggestionsProps {
  suggestions: string[]
  onSelect: (suggestion: string) => void
  className?: string
}

export function Suggestions({ suggestions, onSelect, className }: SuggestionsProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  if (suggestions.length === 0) return null

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className={cn('w-full', className)}
    >
      {suggestions.map((suggestion) => (
        <Pressable
          key={suggestion}
          onPress={() => onSelect(suggestion)}
          className="rounded-full px-4 py-1.5 mr-2"
          style={{ borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.card }}
        >
          <Text className="text-xs" style={{ color: tokens.foreground }}>{suggestion}</Text>
        </Pressable>
      ))}
    </ScrollView>
  )
}
