import { useEffect, useState } from 'react'
import { Modal, View, Text, Pressable, Animated, Switch, StyleSheet, Dimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { LucideIcon } from 'lucide-react-native'
import { Camera, Image as ImageIcon, Paperclip, Settings2, Bot, Network, FileText, RefreshCw } from 'lucide-react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export interface AttachmentSheetMode {
  id: string
  icon: LucideIcon
  label: string
  active: boolean
}

interface AttachmentSheetProps {
  visible: boolean
  onClose: () => void
  onCamera: () => void
  onPhotos: () => void
  onFiles: () => void
  modes: AttachmentSheetMode[]
  onToggleMode: (id: string) => void
  plan: boolean
  subagents: boolean
  orchestra: boolean
  loop: boolean
  onConfigureWorkers: () => void
  onConfigureLoop?: () => void
}

const SHEET_HEIGHT = Math.min(Dimensions.get('window').height * 0.72, 560)

export function AttachmentSheet({
  visible,
  onClose,
  onCamera,
  onPhotos,
  onFiles,
  modes,
  onToggleMode,
  plan,
  subagents,
  orchestra,
  loop,
  onConfigureWorkers,
  onConfigureLoop,
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

  const switchTrack = { false: tokens.muted, true: tokens.primary }

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

        <View style={s.modesList}>
          {modes.map((mode) => {
            const Icon = mode.icon
            return (
              <Pressable key={mode.id} onPress={() => onToggleMode(mode.id)} style={[s.modeCard, { backgroundColor: tokens.border }]}>
                <View style={s.modeCardLeft}>
                  <Icon size={18} color={tokens.mutedForeground} />
                  <Text style={[s.modeCardLabel, { color: tokens.foreground }]}>{mode.label}</Text>
                </View>
                <Switch
                  value={mode.active}
                  onValueChange={() => onToggleMode(mode.id)}
                  trackColor={switchTrack}
                  thumbColor={tokens.foreground}
                />
              </Pressable>
            )
          })}
        </View>

        <View style={[s.divider, { backgroundColor: tokens.border }]} />
        <View style={s.modesList}>
          <WorkerModeCard
            icon={FileText}
            label="Modo Plano"
            active={plan}
            onToggle={() => onToggleMode('plan')}
            onConfigure={undefined as any}
            tokens={tokens}
            hideGear
          />
          <WorkerModeCard
            icon={Bot}
            label="Subagentes"
            active={subagents}
            onToggle={() => onToggleMode('subagents')}
            onConfigure={onConfigureWorkers}
            tokens={tokens}
          />
          <WorkerModeCard
            icon={Network}
            label="Orquestração"
            active={orchestra}
            onToggle={() => onToggleMode('orchestra')}
            onConfigure={onConfigureWorkers}
            tokens={tokens}
          />
          <WorkerModeCard
            icon={RefreshCw}
            label="Loop"
            active={loop}
            onToggle={() => onToggleMode('loop')}
            onConfigure={onConfigureLoop ?? (() => {})}
            tokens={tokens}
          />
        </View>
      </Animated.View>
    </Modal>
  )
}

function WorkerModeCard({
  icon: Icon,
  label,
  active,
  onToggle,
  onConfigure,
  tokens,
  hideGear,
}: {
  icon: LucideIcon
  label: string
  active: boolean
  onToggle: () => void
  onConfigure: () => void
  tokens: ReturnType<typeof getThemeTokens>
  hideGear?: boolean
}) {
  return (
    <Pressable onPress={onToggle} style={[s.modeCard, { backgroundColor: tokens.border }]}>
      <View style={s.modeCardLeft}>
        <Icon size={18} color={tokens.mutedForeground} />
        <Text style={[s.modeCardLabel, { color: tokens.foreground }]}>{label}</Text>
      </View>
      <View style={s.workerRight}>
        {!hideGear && (
          <Pressable onPress={onConfigure} hitSlop={8} style={[s.gearBtn, { backgroundColor: tokens.muted }]}>
            <Settings2 size={16} color={tokens.mutedForeground} />
          </Pressable>
        )}
        <Switch
          value={active}
          onValueChange={onToggle}
          trackColor={{ false: tokens.muted, true: tokens.primary }}
          thumbColor={tokens.foreground}
        />
      </View>
    </Pressable>
  )
}

function SheetAction({ icon: Icon, label, onPress, tokens }: { icon: LucideIcon; label: string; onPress: () => void; tokens: ReturnType<typeof getThemeTokens> }) {
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
  modesList: { gap: 8, paddingBottom: 8 },
  divider: { height: 1, marginVertical: 8 },
  modeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  modeCardLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  modeCardLabel: { fontSize: 14, fontWeight: '500' },
  workerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  gearBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
