import { useMemo, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Check, Copy } from 'lucide-react-native'
import {
  darkSyntaxPalette,
  displayLanguage,
  highlightCode,
  lightSyntaxPalette,
} from '~/lib/syntax-highlight'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface CodeBlockProps {
  code: string
  language?: string
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const resolved = useThemeStore((s) => s.resolved)
  const tokens = getThemeTokens(resolved)
  const [copied, setCopied] = useState(false)
  const palette = resolved === 'dark' ? darkSyntaxPalette : lightSyntaxPalette
  const langLabel = displayLanguage(language)

  const highlighted = useMemo(
    () => highlightCode(code, language, palette),
    [code, language, palette],
  )

  const onCopy = async () => {
    await Clipboard.setStringAsync(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <View
      className="overflow-hidden rounded-xl"
      style={{
        backgroundColor: tokens.card,
        borderWidth: 1,
        borderColor: tokens.border,
      }}
    >
      <View
        className="flex-row items-center justify-between px-3 py-1.5"
        style={{
          backgroundColor: tokens.muted,
          borderBottomWidth: 1,
          borderBottomColor: tokens.border,
        }}
      >
        <Text className="font-mono text-[11px] lowercase" style={{ color: tokens.mutedForeground }}>
          {langLabel}
        </Text>
        <Pressable
          onPress={onCopy}
          hitSlop={8}
          className="flex-row items-center gap-1 rounded-md px-1.5 py-1 active:opacity-70"
        >
          {copied ? (
            <Check size={12} color={tokens.mutedForeground} />
          ) : (
            <Copy size={12} color={tokens.mutedForeground} />
          )}
          <Text className="text-[11px]" style={{ color: tokens.mutedForeground }}>
            {copied ? 'Copiado' : 'Copiar'}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
        <View className="px-3 py-2.5">
          <Text className="font-mono text-xs leading-5" selectable>
            {highlighted.map((token, i) => (
              <Text key={i} style={{ color: token.color ?? palette.foreground }}>
                {token.text}
              </Text>
            ))}
          </Text>
        </View>
      </ScrollView>
    </View>
  )
}
