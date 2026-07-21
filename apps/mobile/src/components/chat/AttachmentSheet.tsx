import { useEffect, useState } from 'react'
import { Modal, View, Text, Pressable, Animated, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Camera, Image as ImageIcon, Paperclip } from 'lucide-react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface AttachmentSheetProps {
  visible: boolean
  onClose: () => void
  onCamera: () => void
  onPhotos: () => void
  onFiles: () => void
}

const SHEET_HEIGHT = 200

export function AttachmentSheet({
  visible,
  onClose,
  onCamera,
  onPhotos,
  onFiles,
}: AttachmentSheetProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()
  const [slideAnim] = useState(() => new Animated.Value(SHEET_HEIGHT))
  const [backdropAnim] = useState(() => new Animated.Value(0))

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: visible ? 0 : SHEET_HEIGHT,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(backdropAnim, {
        toValue: visible ? 1 : 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start()
  }, [visible, slideAnim, backdropAnim])

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[s.backdrop, { opacity: backdropAnim }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>

      <Animated.View
        style={[
          s.sheet,
          { paddingBottom: insets.bottom + 12, transform: [{ translateY: slideAnim }], backgroundColor: tokens.card, borderColor: tokens.border },
        ]}
      >
        <View style={[s.handle, { backgroundColor: tokens.muted }]} />

        <View style={[s.actionsRow, { borderBottomColor: tokens.border }]}>
          <SheetAction icon={Camera} label="Câmera" onPress={onCamera} tokens={tokens} />
          <SheetAction icon={ImageIcon} label="Fotos" onPress={onPhotos} tokens={tokens} />
          <SheetAction icon={Paperclip} label="Arquivos" onPress={onFiles} tokens={tokens} />
        </View>
      </Animated.View>
    </Modal>
  )
}

function SheetAction({ icon: Icon, label, onPress, tokens }: { icon: typeof Camera; label: string; onPress: () => void; tokens: ReturnType<typeof getThemeTokens> }) {
  return (
    <Pressable onPress={onPress} style={s.action}>
      <View style={[s.actionIcon, { backgroundColor: tokens.muted }]}>
        <Icon size={22} color={tokens.foreground} />
      </View>
      <Text style={[s.actionLabel, { color: tokens.mutedForeground }]}>{label}</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    paddingTop: 10,
    paddingHorizontal: 16,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 16,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingBottom: 16,
    marginBottom: 8,
    borderBottomWidth: 1,
  },
  action: { alignItems: 'center', gap: 8 },
  actionIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { fontSize: 12, fontWeight: '500' },
})
