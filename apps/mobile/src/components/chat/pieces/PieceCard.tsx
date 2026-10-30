import type { PieceRef } from '@orbit/shared'
import { Image } from 'expo-image'
import { ChevronRight, Film, Frame, Presentation } from 'lucide-react-native'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

import { PieceViewer } from './PieceViewer'

/**
 * The piece card — a single one, for motion, design and slides.
 *
 * The geometry is fixed on purpose (72 tall, cover 56×56): an answer with
 * the three types stacked cannot become a staircase of different heights.
 * What changes between them is the icon and the pill with the type name, not the shape.
 *
 * Nothing here loads a WebView. The card is image, text and a tap — the piece is only
 * mounted when the person opens it (`PieceViewer`). That is what keeps a long
 * conversation with ten pieces costing the same as one with none.
 */

const KIND_ICON = { motion: Film, design: Frame, slides: Presentation } as const

export const PIECE_CARD_HEIGHT = 72

export function PieceCard({ piece }: { piece: PieceRef }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [open, setOpen] = useState(false)

  const Icon = KIND_ICON[piece.kind]
  const kindLabel = t(`pieces.kind.${piece.kind}`)
  const title = piece.title?.trim() || kindLabel

  // Motion counts in seconds, design in screens, slides in slides — the same field
  // of the protocol, three units.
  const meta =
    piece.kind === 'motion'
      ? piece.count
        ? t('pieces.meta.seconds', { count: piece.count })
        : null
      : piece.count
        ? t(piece.kind === 'design' ? 'pieces.meta.screens' : 'pieces.meta.slides', {
            count: piece.count,
          })
        : null

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={t('pieces.open', { title })}
        className="w-full flex-row items-center gap-3 rounded-xl border px-2.5"
        style={{
          height: PIECE_CARD_HEIGHT,
          borderColor: tokens.border,
          backgroundColor: tokens.card,
        }}
      >
        {piece.cover ? (
          <Image
            source={{ uri: piece.cover }}
            style={{ width: 56, height: 56, borderRadius: 10 }}
            contentFit="cover"
            accessibilityIgnoresInvertColors
          />
        ) : (
          // No cover (an old piece, or the desktop did not generate a frame): the icon of the
          // type in a tinted square. Better than a hole, and the card keeps
          // the same size.
          <View
            className="items-center justify-center rounded-[10px]"
            style={{ width: 56, height: 56, backgroundColor: tokens.muted }}
          >
            <Icon size={20} color={tokens.mutedForeground} />
          </View>
        )}

        <View className="flex-1 justify-center gap-1">
          <View className="flex-row items-center gap-1.5">
            <Icon size={13} color={tokens.primary} />
            <Text
              numberOfLines={1}
              className="shrink text-sm font-medium"
              style={{ color: tokens.foreground }}
            >
              {title}
            </Text>
            <View
              className="rounded px-1.5 py-[1px]"
              style={{ backgroundColor: tokens.muted }}
            >
              <Text
                className="text-[9px] font-semibold uppercase tracking-wide"
                style={{ color: tokens.mutedForeground }}
              >
                {kindLabel}
              </Text>
            </View>
          </View>
          {meta ? (
            <Text className="text-[11px]" style={{ color: tokens.mutedForeground }}>
              {meta}
            </Text>
          ) : null}
        </View>

        <ChevronRight size={16} color={tokens.mutedForeground} />
      </Pressable>

      {open ? <PieceViewer piece={piece} onClose={() => setOpen(false)} /> : null}
    </>
  )
}
