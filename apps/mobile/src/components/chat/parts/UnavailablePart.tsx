/**
 * Card discreto para uma part que não tem como ser mostrada — URL ausente (part
 * antiga em cache, arquivo que o desktop não conseguiu servir). Mantém o título
 * visível: o texto do assistente pode falar de algo que o usuário ainda precisa
 * identificar, mesmo sem conseguir abrir.
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
