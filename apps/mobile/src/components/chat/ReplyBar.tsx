import { View, Text, Pressable } from 'react-native'
import { MessageSquareQuote, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { replySnippet, type MessageReplyQuote } from '@orbit/shared'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useReply } from '~/stores/reply-store'

/** Label of whoever wrote the replied message — the stored text carries the
 *  role (`[assistant]`), and the translation comes from here. */
export function useReplyLabel() {
  const { t } = useTranslation()
  return (role: MessageReplyQuote['role']) =>
    t(role === 'user' ? 'reply.you' : 'reply.assistant')
}

/**
 * Quote of the replied message, above the text field (as in WhatsApp).
 *
 * It lives in the composer because the composer is what says what is going to leave: without the bar, the text
 * sent would gain a quote nobody saw being chosen. The X undoes the
 * reply without touching the typed text.
 */
export function ReplyBar({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const reply = useReply((s) => s.replies[sessionId ?? 'draft'])
  const clearReply = useReply((s) => s.clearReply)
  const label = useReplyLabel()
  if (!reply) return null

  return (
    <View
      className="flex-row items-start gap-2 mb-1.5"
      style={{
        borderLeftWidth: 2,
        borderLeftColor: tokens.primary,
        backgroundColor: withAlpha(tokens.muted, 0.5),
        paddingHorizontal: 8,
        paddingVertical: 4,
      }}
    >
      <MessageSquareQuote size={13} color={tokens.primary} style={{ marginTop: 2 }} />
      <View className="flex-1 min-w-0">
        <Text style={{ fontSize: 11, fontWeight: '600', color: tokens.primary }}>
          {label(reply.role)}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 11, color: tokens.mutedForeground }}>
          {replySnippet(reply.text)}
        </Text>
      </View>
      <Pressable
        onPress={() => clearReply(sessionId)}
        accessibilityLabel={t('reply.cancel')}
        hitSlop={8}
        style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.6 : 1 })}
      >
        <X size={12} color={tokens.mutedForeground} />
      </Pressable>
    </View>
  )
}
