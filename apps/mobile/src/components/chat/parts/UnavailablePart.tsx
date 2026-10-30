/**
 * Discreet card for a part that cannot be shown — missing URL (an old part
 * in the cache, a file the desktop could not serve). It keeps the title
 * visible: the assistant text may talk about something the user still needs
 * to identify, even without being able to open it.
 */
import { View, Text } from 'react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export function UnavailablePart({
  title,
  label,
  testID,
}: {
  title?: string
  label: string
  testID?: string
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <View
      testID={testID}
      className="mt-2 w-full gap-1 rounded-lg px-3 py-2"
      style={{ borderWidth: 1, borderStyle: 'dashed', borderColor: tokens.border }}
    >
      {title ? (
        <Text className="text-xs font-medium" style={{ color: tokens.foreground }}>
          {title}
        </Text>
      ) : null}
      <Text className="text-xs" style={{ color: tokens.mutedForeground }}>
        {label}
      </Text>
    </View>
  )
}
