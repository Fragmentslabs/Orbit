import { useRef, useState } from 'react'
import { Animated, PanResponder, Pressable, Text, View } from 'react-native'
import { History, MessageSquareText, Undo2, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { SessionInfo } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const SWIPE_THRESHOLD = 60

interface RevertBarProps {
  session: SessionInfo
  onUnrevert: (sessionId: string) => void
  onDismiss: (sessionId: string) => void
}

export function RevertBar({ session, onUnrevert, onDismiss }: RevertBarProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [dismissed, setDismissed] = useState(false)
  const translateY = useRef(new Animated.Value(0)).current

  const revert = session.revert
  if (!revert || dismissed) return null

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) => gs.dy > 10,
      onPanResponderMove: (_, gs) => {
        if (gs.dy > 0) {
          translateY.setValue(gs.dy)
        }
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > SWIPE_THRESHOLD) {
          Animated.timing(translateY, {
            toValue: 300,
            duration: 200,
            useNativeDriver: true,
          }).start(() => {
            setDismissed(true)
            onDismiss(session.id)
          })
        } else {
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
          }).start()
        }
      },
    }),
  ).current

  const isCode = Boolean(revert.files || revert.diff)
  const count = revert.files?.length ?? 0
  const label = isCode
    ? count === 0
      ? t('revertBar.filesRevertedNone')
      : t('revertBar.filesReverted', { count })
    : t('revertBar.conversationReverted')

  return (
    <Animated.View
      style={{ transform: [{ translateY }] }}
      {...panResponder.panHandlers}
    >
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
            {t('revertBar.continuesFromHere')}
          </Text>
        </Text>
        <Pressable
          onPress={() => onUnrevert(session.id)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: tokens.border,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Undo2 size={12} color={tokens.foreground} />
          <Text style={{ fontSize: 12, color: tokens.foreground }}>{t('revertBar.undo')}</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            setDismissed(true)
            onDismiss(session.id)
          }}
          style={({ pressed }) => ({
            padding: 4,
            borderRadius: 4,
            opacity: pressed ? 0.6 : 1,
          })}
          hitSlop={8}
        >
          <X size={14} color={tokens.mutedForeground} />
        </Pressable>
      </View>
    </Animated.View>
  )
}
