import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Image } from 'expo-image'
import { Paperclip, X } from 'lucide-react-native'
import type { FilePart } from '@orbit/shared'
import { openFilePart } from '~/lib/attachments'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export function InputAttachment({ file, onRemove }: { file: FilePart; onRemove: () => void }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const isImage = file.mime.startsWith('image/')
  return (
    <Pressable onPress={() => void openFilePart(file)} style={[s.inputChip, { borderColor: tokens.border, backgroundColor: tokens.border }]}>
      {isImage ? (
        <Image source={file.url} style={s.inputThumb} contentFit="cover" />
      ) : (
        <Paperclip size={13} color={tokens.mutedForeground} />
      )}
      <Text style={[s.inputChipText, { color: tokens.foreground }]} numberOfLines={1}>
        {file.filename ?? 'Arquivo'}
      </Text>
      <Pressable onPress={onRemove} hitSlop={8} style={[s.removeBtn, { backgroundColor: tokens.muted }]}>
        <X size={11} color={tokens.mutedForeground} />
      </Pressable>
    </Pressable>
  )
}

export function MessageAttachment({ file }: { file: FilePart }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const isImage = file.mime.startsWith('image/')

  if (isImage) {
    return (
      <Pressable onPress={() => void openFilePart(file)} style={[s.imageWrap, { borderColor: tokens.border }]}>
        <Image source={file.url} style={s.image} contentFit="cover" />
      </Pressable>
    )
  }

  return (
    <Pressable onPress={() => void openFilePart(file)} style={[s.fileChip, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <Paperclip size={13} color={tokens.mutedForeground} />
      <Text style={[s.fileChipText, { color: tokens.foreground }]} numberOfLines={1}>
        {file.filename ?? 'Arquivo'}
      </Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  inputChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 170,
    borderRadius: 10,
    borderWidth: 1,
    paddingLeft: 8,
    paddingRight: 6,
    paddingVertical: 6,
  },
  inputThumb: { width: 22, height: 22, borderRadius: 5 },
  inputChipText: { flex: 1, fontSize: 12, fontWeight: '500' },
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
