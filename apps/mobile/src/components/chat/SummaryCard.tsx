import { useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { NotebookPen, ChevronDown } from 'lucide-react-native'
import { AssistantMarkdown } from '~/components/chat/AssistantMarkdown'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'
import type { ChatMessage } from '@orbit/shared'

function messageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<ChatMessage['parts'][number], { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

export function SummaryCard({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const hsl = (v: string) => v.replace(/hsla?\(|\)/g, '').replace(/,/g, '')

  return (
    <View className="my-2 w-full">
      <Pressable
        onPress={() => setOpen((v) => !v)}
        className="flex-row items-center gap-2 rounded-t-lg border px-3 py-2"
        style={{
          backgroundColor: hslToRgba(hsl(tokens.muted), 0.3),
          borderColor: tokens.border,
          borderBottomLeftRadius: open ? 0 : 8,
          borderBottomRightRadius: open ? 0 : 8,
        }}
      >
        <NotebookPen size={14} color={tokens.mutedForeground} />
        <Text className="flex-1 text-xs" style={{ color: tokens.mutedForeground }}>
          Resumo das mensagens anteriores (contexto compactado)
        </Text>
        <ChevronDown
          size={14}
          color={tokens.mutedForeground}
          style={{ transform: open ? [{ rotate: '180deg' }] : undefined }}
        />
      </Pressable>
      {open && (
        <View
          className="rounded-b-lg border border-t-0 px-3 py-2"
          style={{
            backgroundColor: hslToRgba(hsl(tokens.muted), 0.1),
            borderColor: tokens.border,
          }}
        >
          <AssistantMarkdown text={messageText(message)} />
        </View>
      )}
    </View>
  )
}
