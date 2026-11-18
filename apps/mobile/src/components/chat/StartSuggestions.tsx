import { Pressable, Text, View } from 'react-native'
import { ChevronRight, History } from 'lucide-react-native'
import type { StartSuggestion } from '@orbit/shared'
import { CapabilityIcon } from '~/components/chat/CapabilityIcon'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/**
 * The start screen's suggestions, the desktop's rule drawn for the phone: with a conversation to
 * resume, only that one ("Resume", the whole row); without, two capabilities side by side. A dot
 * marks a family the person has never produced. Tapping hands the suggestion to the screen, which
 * fills the composer or opens the conversation — never sends.
 */
export function StartSuggestions({
  suggestions,
  onPick,
}: {
  suggestions: StartSuggestion[]
  onPick: (suggestion: StartSuggestion) => void
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  if (suggestions.length === 0) return null

  const card = { borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.card, borderRadius: 14 } as const
  const resume = suggestions[0]?.action.kind === 'open' ? suggestions[0] : null

  if (resume) {
    return (
      <Pressable
        onPress={() => onPick(resume)}
        accessibilityRole="button"
        style={[card, { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 10 }]}
      >
        <History size={16} color={tokens.mutedForeground} />
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: tokens.foreground }}>
          {resume.label}
        </Text>
        <ChevronRight size={16} color={tokens.mutedForeground} />
      </Pressable>
    )
  }

  return (
    <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'center' }}>
      {suggestions.map((suggestion) => (
        <Pressable
          key={suggestion.id}
          onPress={() => onPick(suggestion)}
          accessibilityRole="button"
          style={[card, { flex: 1, maxWidth: '50%', flexDirection: 'row', alignItems: 'flex-start', gap: 8, minHeight: 64, padding: 12 }]}
        >
          {suggestion.capability ? (
            <View style={{ marginTop: 1 }}>
              <CapabilityIcon capability={suggestion.capability} size={16} color={tokens.mutedForeground} />
            </View>
          ) : null}
          <Text style={{ flex: 1, fontSize: 14, lineHeight: 18, color: tokens.foreground }}>{suggestion.label}</Text>
          {suggestion.fresh ? (
            <View style={{ width: 6, height: 6, borderRadius: 3, marginTop: 5, backgroundColor: tokens.primary }} />
          ) : null}
        </Pressable>
      ))}
    </View>
  )
}
