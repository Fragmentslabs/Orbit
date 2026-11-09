import { useState } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Image } from 'expo-image'
import { Paperclip, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { FilePart } from '@orbit/shared'
import { openFilePart } from '~/lib/attachments'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { ImageLightbox } from './ImageLightbox'

export function InputAttachment({ file, onRemove }: { file: FilePart; onRemove: () => void }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const isImage = file.mime.startsWith('image/')
  const [lightboxOpen, setLightboxOpen] = useState(false)
  return (
    <>
      <Pressable
        onPress={() => (isImage ? setLightboxOpen(true) : void openFilePart(file))}
        accessibilityLabel={isImage ? t('attachment.enlarge') : t('attachment.defaultFilename')}
        style={[s.inputChip, { borderColor: tokens.border, backgroundColor: tokens.card }]}
      >
        {isImage ? (
          <Image source={file.url} style={s.inputThumb} contentFit="cover" />
        ) : (
          <Paperclip size={13} color={tokens.mutedForeground} />
        )}
        <Text style={[s.inputChipText, { color: tokens.foreground }]} numberOfLines={1}>
          {file.filename ?? t('attachment.defaultFilename')}
        </Text>
        <Pressable onPress={onRemove} hitSlop={8} style={[s.removeBtn, { backgroundColor: tokens.muted }]}>
          <X size={11} color={tokens.mutedForeground} />
        </Pressable>
      </Pressable>
      {isImage && file.url && (
        <ImageLightbox src={file.url} alt={file.filename} open={lightboxOpen} onOpenChange={setLightboxOpen} />
      )}
    </>
  )
}

export function MessageAttachment({ file }: { file: FilePart }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const isImage = file.mime.startsWith('image/')
  const [lightboxOpen, setLightboxOpen] = useState(false)

  if (isImage) {
    return (
      <>
        <Pressable
          onPress={() => setLightboxOpen(true)}
          accessibilityLabel={t('attachment.enlarge')}
          style={[s.imageWrap, { borderColor: tokens.border }]}
        >
          <Image source={file.url} style={s.image} contentFit="cover" />
        </Pressable>
        {/*
          The list shows the thumbnail (light, it already came in the message); enlarging takes
          the original from the gallery. The desktop rewrites the mediaUrl to a signed
          HTTP before sending — here it arrives ready to load.
        */}
        {(file.mediaUrl || file.url) && (
          <ImageLightbox
            src={file.mediaUrl || file.url}
            alt={file.filename}
            open={lightboxOpen}
            onOpenChange={setLightboxOpen}
          />
        )}
      </>
    )
  }

  // Chip without url (content already extracted as text, e.g. PDF/spreadsheet/DOCX) —
  // there is no original file to open, so it does not simulate a touch that does nothing.
  if (!file.url) {
    return (
      <View style={[s.fileChip, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
        <Paperclip size={13} color={tokens.mutedForeground} />
        <Text style={[s.fileChipText, { color: tokens.foreground }]} numberOfLines={1}>
          {file.filename ?? t('attachment.defaultFilename')}
        </Text>
      </View>
    )
  }

  return (
    <Pressable onPress={() => void openFilePart(file)} style={[s.fileChip, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <Paperclip size={13} color={tokens.mutedForeground} />
      <Text style={[s.fileChipText, { color: tokens.foreground }]} numberOfLines={1}>
        {file.filename ?? t('attachment.defaultFilename')}
      </Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  inputChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    maxWidth: 200,
    borderRadius: 8,
    borderWidth: 1,
    paddingLeft: 6,
    paddingRight: 6,
  },
  inputThumb: { width: 20, height: 20, borderRadius: 4 },
  inputChipText: { flexShrink: 1, fontSize: 13, fontWeight: '500' },
  removeBtn: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },

  imageWrap: {
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
  },
  image: { width: 200, height: 150 },

  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
    maxWidth: 200,
  },
  fileChipText: { fontSize: 12, fontWeight: '500' },
})
