import { useState } from 'react'
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
  /** "Revert as well" the files of uncertain authorship. */
  onRevertUncertain?: (sessionId: string) => void
  onDismiss: (sessionId: string) => void
  /** Inside the conversation the vertical drag (dy > 10) fights with the scroll of the
   *  list: there the bar only closes through the X. Outside it the gesture still works. */
  swipeToDismiss?: boolean
}

export function RevertBar({
  session,
  onUnrevert,
  onRevertUncertain,
  onDismiss,
  swipeToDismiss = true,
}: RevertBarProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [dismissed, setDismissed] = useState(false)
  // useState with a lazy initializer instead of `useRef(new ...).current`:
  // an equally stable value, readable during render (react-hooks/refs forbids reading a
  // ref here) and allocated only once.
  const [translateY] = useState(() => new Animated.Value(0))

  const revert = session.revert

  // The early return CANNOT come before this useRef: when dragging the bar,
  // setDismissed(true) triggers a render that would skip the hook and React
  // would take the tree down with "Rendered fewer hooks than expected".
  const [panResponder] = useState(() =>
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
  )

  // Now yes: all the hooks have already run.
  if (!revert || dismissed) return null

  const isCode = Boolean(revert.files || revert.diff)
  const count = revert.files?.length ?? 0
  const filesNotRestored = Boolean(session.directory) && revert.filesRestored === false
  const label = filesNotRestored
    ? t(
        revert.reason === 'capture-failed'
          ? 'revertBar.filesRestoreFailed'
          : revert.reason === 'no-end-snapshot'
            ? 'revertBar.filesNoEndSnapshot'
            : 'revertBar.filesNotRestored',
      )
    : isCode
      ? count === 0
        ? t('revertBar.filesRevertedNone')
        : t('revertBar.filesReverted', { count })
      : t('revertBar.conversationReverted')
  // Pieces and gallery: the desktop undoes in both modes and sends only the counters.
  const media = revert.media
  const mediaParts = [
    media?.pieces ? t('revertBar.mediaPieces', { count: media.pieces }) : null,
    media?.items ? t('revertBar.mediaItems', { count: media.items }) : null,
  ].filter(Boolean)
  const mediaLabel =
    media?.restored === false
      ? t('revertBar.mediaFailed')
      : mediaParts.length > 0
        ? t('revertBar.mediaReverted', { what: mediaParts.join(', ') })
        : ''
  // What changed after the turn and stayed intact.
  const filesKept = revert.conflicts?.length ?? 0
  const mediaKept = media?.conflicts ?? 0
  const keptParts = [
    filesKept > 0
      ? filesKept === 1
        ? t('revertBar.filesKept', { count: 1 })
        : t('revertBar.filesKept', { count: filesKept })
      : null,
    mediaKept > 0
      ? mediaKept === 1
        ? t('revertBar.mediaKept', { count: 1 })
        : t('revertBar.mediaKept', { count: mediaKept })
      : null,
  ].filter(Boolean)
  const keptLabel = keptParts.length > 0 ? ` · ${keptParts.join(', ')}` : ''
  // Changed during the turn by another path (bash, MCP, something from outside): it was not
  // reverted — the person decides.
  const uncertainCount = revert.uncertain?.length ?? 0
  const uncertainLabel = uncertainCount > 0 ? ` · ${t('revertBar.uncertain', { count: uncertainCount })}` : ''

  return (
    <Animated.View
      style={{ transform: [{ translateY }] }}
      {...(swipeToDismiss ? panResponder.panHandlers : {})}
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
          {mediaLabel ? <Text style={{ color: tokens.mutedForeground }}>{mediaLabel}</Text> : null}
          {keptLabel ? <Text style={{ color: tokens.destructive }}>{keptLabel}</Text> : null}
          {uncertainLabel ? <Text style={{ color: tokens.mutedForeground }}>{uncertainLabel}</Text> : null}
          <Text style={{ color: tokens.mutedForeground }}>
            {t('revertBar.continuesFromHere')}
          </Text>
        </Text>
        {uncertainCount > 0 && onRevertUncertain ? (
          <Pressable
            onPress={() => onRevertUncertain(session.id)}
            style={({ pressed }) => ({
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ fontSize: 12, color: tokens.foreground }}>{t('revertBar.revertUncertain')}</Text>
          </Pressable>
        ) : null}
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
