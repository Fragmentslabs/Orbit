import type { PieceRef } from '@orbit/shared'
import { X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { Modal, Pressable, Text, View } from 'react-native'

import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

import { VIEWERS } from './viewers'

/**
 * The open piece — the equivalent of the desktop side panel.
 *
 * On the desktop the card and the panel coexist: you look at the piece without losing the conversation.
 * On a 6-inch screen that does not fit, so the choice is the layer: the piece covers the
 * chat, and going back returns the conversation where it was.
 *
 * The WebView is only born in here. Closing this layer unmounts the viewer, and with
 * it the process — that is what makes the card cheap.
 */
export function PieceViewer({ piece, onClose }: { piece: PieceRef; onClose: () => void }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const Viewer = VIEWERS[piece.kind]

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View className="flex-1" style={{ backgroundColor: tokens.background }}>
        <View
          className="flex-row items-center gap-2 border-b px-3 py-2.5"
          style={{ borderColor: tokens.border }}
        >
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t('pieces.close')}
            hitSlop={10}
            className="h-8 w-8 items-center justify-center rounded-full"
            style={{ backgroundColor: tokens.muted }}
          >
            <X size={16} color={tokens.foreground} />
          </Pressable>

          <View className="flex-1">
            <Text
              numberOfLines={1}
              className="text-sm font-medium"
              style={{ color: tokens.foreground }}
            >
              {piece.title?.trim() || t(`pieces.kind.${piece.kind}`)}
            </Text>
          </View>

          <View className="rounded px-1.5 py-[1px]" style={{ backgroundColor: tokens.muted }}>
            <Text
              className="text-[9px] font-semibold uppercase tracking-wide"
              style={{ color: tokens.mutedForeground }}
            >
              {t(`pieces.kind.${piece.kind}`)}
            </Text>
          </View>
        </View>

        <Viewer piece={piece} />
      </View>
    </Modal>
  )
}
