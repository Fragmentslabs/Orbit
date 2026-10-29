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
 * O card de peça — um só, para motion, design e slides.
 *
 * A geometria é fixa de propósito (72 de altura, capa 56×56): uma resposta com
 * os três tipos empilhados não pode virar uma escadinha de alturas diferentes.
 * O que muda entre eles é o ícone e a pílula com o nome do tipo, não o formato.
 *
 * Nada aqui carrega WebView. O card é imagem, texto e um toque — a peça só é
 * montada quando a pessoa abre (`PieceViewer`). É o que mantém uma conversa
 * longa com dez peças custando o mesmo que uma com nenhuma.
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

  // Motion conta em segundos, design em telas, slides em slides — o mesmo campo
  // do protocolo, três unidades.
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
          // Sem capa (peça antiga, ou o desktop não gerou frame): o ícone do
          // tipo num quadrado tingido. Melhor que um buraco, e o card continua
          // com a mesma medida.
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
