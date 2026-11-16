import type { PieceRef } from '@orbit/shared'
import { ChevronRight, Film, Frame, Presentation } from 'lucide-react-native'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

import { PieceViewer } from './PieceViewer'

/**
 * The piece card — a single one, for motion, design and slides, in the shape of the
 * desktop's: a tinted square with the type icon, the name and one quiet line under it
 * ("Motion · 32s"), and a chevron. A conversation with the three types stacked keeps the
 * same rhythm because nothing changes between them but the icon and the words.
 *
 * Nothing here loads a WebView. The card is icon, text and a tap — the piece is only
 * mounted when the person opens it (`PieceViewer`). That is what keeps a long
 * conversation with ten pieces costing the same as one with none.
 */

const KIND_ICON = { motion: Film, design: Frame, slides: Presentation } as const

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
  const subtitle = meta ? `${kindLabel} · ${meta}` : kindLabel

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={t('pieces.open', { title })}
        className="my-2.5 min-h-14 w-full flex-row items-center gap-2.5 rounded-xl border px-3 py-2"
        style={{ borderColor: tokens.border, backgroundColor: tokens.card }}
      >
        <View
          className="items-center justify-center rounded-[10px]"
          style={{ width: 36, height: 36, backgroundColor: tokens.muted }}
        >
          <Icon size={18} color={tokens.primary} />
        </View>

        <View className="flex-1 justify-center gap-0.5">
          <Text numberOfLines={1} className="text-sm font-medium" style={{ color: tokens.foreground }}>
            {title}
          </Text>
          <Text numberOfLines={1} className="text-xs" style={{ color: tokens.mutedForeground }}>
            {subtitle}
          </Text>
        </View>

        <ChevronRight size={16} color={tokens.mutedForeground} />
      </Pressable>

      {open ? <PieceViewer piece={piece} onClose={() => setOpen(false)} /> : null}
    </>
  )
}
