import { View, Text, Pressable } from 'react-native'
import { Reply, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { replySnippet, type MessageReplyQuote } from '@orbit/shared'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useReply } from '~/stores/reply-store'

/** Rótulo de quem escreveu a mensagem respondida — o texto gravado traz o
 *  papel (`[assistant]`), e a tradução sai daqui. */
export function useReplyLabel() {
  const { t } = useTranslation()
  return (role: MessageReplyQuote['role']) =>
    t(role === 'user' ? 'reply.you' : 'reply.assistant')
}

/**
 * Citação da mensagem respondida, acima do campo de texto (como no WhatsApp).
 *
 * Fica no compositor porque é ele que diz o que vai sair: sem a barra, o texto
 * enviado ganharia uma citação que ninguém viu sendo escolhida. O X desfaz a
 * resposta sem mexer no texto digitado.
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
      <Reply size={13} color={tokens.primary} style={{ marginTop: 2 }} />
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
