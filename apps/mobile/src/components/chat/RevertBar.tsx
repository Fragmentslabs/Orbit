import { Pressable, Text, View } from 'react-native'
import { History, MessageSquareText, Undo2 } from 'lucide-react-native'
import type { SessionInfo } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface RevertBarProps {
  session: SessionInfo
  onUnrevert: (sessionId: string) => void
}

export function RevertBar({ session, onUnrevert }: RevertBarProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const revert = session.revert
  if (!revert) return null

  const isCode = Boolean(revert.files || revert.diff)
  const count = revert.files?.length ?? 0
  const label = isCode
    ? count === 0
      ? 'Arquivos revertidos'
      : count === 1
        ? '1 arquivo revertido'
        : `${count} arquivos revertidos`
    : 'Conversa revertida até este ponto'

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.muted + '66',
      }}
    >
      {isCode ? (
        <History size={14} color={tokens.mutedForeground} />
      ) : (
        <MessageSquareText size={14} color={tokens.mutedForeground} />
      )}
      <Text
        style={{
          flex: 1,
          fontSize: 12,
          color: tokens.foreground,
        }}
        numberOfLines={2}
      >
        {label}
        <Text style={{ color: tokens.mutedForeground }}>
          {' '}— nova mensagem continua deste ponto
        </Text>
      </Text>
      <Pressable
        onPress={() => onUnrevert(session.id)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: tokens.border,
        }}
      >
        <Undo2 size={12} color={tokens.foreground} />
        <Text style={{ fontSize: 12, color: tokens.foreground }}>Desfazer</Text>
      </Pressable>
    </View>
  )
}
