import { useEffect, useState } from 'react'
import { Modal, View, Text, Pressable, Animated, Switch, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Camera, Image as ImageIcon, Paperclip, Settings2 } from 'lucide-react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import type { DisplayMode } from '~/stores/appearance-store'

export interface ModeItem {
  id: string
  icon: React.ComponentType<{ size?: number; color?: string }>
  label: string
  active: boolean
  onToggle: () => void
  onConfigure?: () => void
}

interface AttachmentSheetProps {
  visible: boolean
  onClose: () => void
  onCamera: () => void
  onPhotos: () => void
  onFiles: () => void
  modes?: ModeItem[]
  displayMode?: DisplayMode
}

const SHEET_HEIGHT = 200

export function AttachmentSheet({
  visible,
  onClose,
  onCamera,
  onPhotos,
  onFiles,
  modes,
  displayMode,
}: AttachmentSheetProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()
  const [slideAnim] = useState(() => new Animated.Value(SHEET_HEIGHT))
  const [backdropAnim] = useState(() => new Animated.Value(0))

  const showModes = modes && modes.length > 0 && (displayMode === 'actions' || displayMode === 'both')
  const sheetHeight = showModes ? 420 : 200

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: visible ? 0 : sheetHeight,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(backdropAnim, {
        toValue: visible ? 1 : 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start()
  }, [visible, slideAnim, backdropAnim, sheetHeight])

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

        {showModes && modes && (
          <View style={s.modesList}>
            {modes.map((mode) => (
              <View key={mode.id} style={[s.modeRow, { backgroundColor: tokens.border }]}>
                <Pressable onPress={mode.onToggle} style={s.modeRowLeft}>
                  <mode.icon size={18} color={tokens.mutedForeground} />
                  <Text style={[s.modeLabel, { color: tokens.foreground }]}>{mode.label}</Text>
                </Pressable>
                <View style={s.modeRowRight}>
                  {mode.onConfigure && mode.active && (
                    <Pressable onPress={mode.onConfigure} hitSlop={8} style={[s.gearBtn, { backgroundColor: tokens.muted }]}>
                      <Settings2 size={16} color={tokens.mutedForeground} />
                    </Pressable>
                  )}
                  <Switch
                    value={mode.active}
                    onValueChange={mode.onToggle}
                    trackColor={{ false: tokens.muted, true: tokens.primary }}
                    thumbColor={tokens.foreground}
                  />
                </View>
              </View>
            ))}
          </View>
        )}
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
  modesList: { gap: 8, paddingTop: 12 },
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  modeRowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  modeLabel: { fontSize: 14, fontWeight: '500' },
  modeRowRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  gearBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
