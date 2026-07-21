import { useEffect, useState } from 'react'
import { Modal, View, Text, Pressable, Animated, Switch, StyleSheet, ScrollView, Dimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Shield, ShieldCheck, ShieldOff, Brain, Check, Bot, Network, FileText, RefreshCw, ChevronRight, Settings2 } from 'lucide-react-native'
import type { LucideIcon } from 'lucide-react-native'
import type { ModelVariant } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'

type PermissionModeValue = 'ask' | 'approve' | 'full'

const PERMISSION_MODES: { id: PermissionModeValue; label: string; icon: LucideIcon }[] = [
  { id: 'ask', label: 'Perguntar', icon: Shield },
  { id: 'approve', label: 'Autonomia', icon: ShieldCheck },
  { id: 'full', label: 'Irrestrito', icon: ShieldOff },
]

interface Props {
  visible: boolean
  onClose: () => void
  permissionMode: PermissionModeValue
  onPermissionModeChange: (mode: PermissionModeValue) => void
  thinking: boolean
  onThinkingToggle: () => void
  reasoningVariants: ModelVariant[]
  reasoningSelected: string | undefined
  onReasoningSelect: (variantId: string) => void
  reasoningAlwaysOn?: boolean
  subagents: boolean
  onSubagentsToggle: () => void
  orchestra: boolean
  onOrchestraToggle: () => void
  plan: boolean
  onPlanToggle: () => void
  loop: boolean
  onLoopToggle: () => void
  workerModelLabel: string | null
  onConfigureWorkers: () => void
  onConfigureLoop?: () => void
}

const SHEET_HEIGHT = Math.min(Dimensions.get('window').height * 0.72, 560)

export function ConfigSheet({
  visible,
  onClose,
  permissionMode,
  onPermissionModeChange,
  thinking,
  onThinkingToggle,
  reasoningVariants,
  reasoningSelected,
  onReasoningSelect,
  reasoningAlwaysOn,
  subagents,
  onSubagentsToggle,
  orchestra,
  onOrchestraToggle,
  plan,
  onPlanToggle,
  loop,
  onLoopToggle,
  workerModelLabel,
  onConfigureWorkers,
  onConfigureLoop,
}: Props) {
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

  const currentPerm = PERMISSION_MODES.find((m) => m.id === permissionMode) ?? PERMISSION_MODES[0]
  const rowSelectedBg = hslToRgba(
    tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
    0.08,
  )

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[s.backdrop, { opacity: backdropAnim }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>

      <Animated.View
        style={[
          s.sheet,
          { paddingBottom: insets.bottom + 12, transform: [{ translateY: slideAnim }], backgroundColor: tokens.background, borderColor: tokens.border },
        ]}
      >
        <View style={[s.handle, { backgroundColor: tokens.muted }]} />
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text style={[s.sectionTitle, { color: tokens.mutedForeground }]}>Configurações</Text>

          {/* Permission mode */}
          <View style={[s.card, { borderColor: tokens.border }]}>
            <Text style={[s.cardLabel, { color: tokens.foreground }]}>Modo de permissões</Text>
            <View style={s.permissionRow}>
              {PERMISSION_MODES.map((mode) => {
                const ModeIcon = mode.icon
                const active = mode.id === permissionMode
                return (
                  <Pressable
                    key={mode.id}
                    onPress={() => onPermissionModeChange(mode.id)}
                    style={[
                      s.permissionChip,
                      active
                        ? { backgroundColor: tokens.background, borderColor: tokens.border }
                        : { backgroundColor: tokens.muted, borderColor: tokens.border },
                    ]}
                  >
                    <ModeIcon size={16} color={active ? tokens.primary : tokens.mutedForeground} />
                    <Text style={[s.permissionChipLabel, { color: active ? tokens.primary : tokens.mutedForeground }]}>
                      {mode.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          </View>

          {/* Thinking / Reasoning */}
          <View style={[s.card, { borderColor: tokens.border }]}>
            <View style={s.cardRow}>
              <View style={s.cardRowLeft}>
                <Brain size={18} color={tokens.mutedForeground} />
                <Text style={[s.cardLabel, { color: tokens.foreground }]}>Thinking</Text>
              </View>
              <Switch
                value={thinking}
                onValueChange={onThinkingToggle}
                disabled={reasoningAlwaysOn}
                trackColor={{ false: tokens.muted, true: tokens.primary }}
                thumbColor={tokens.foreground}
              />
            </View>
            {thinking && reasoningVariants.length > 0 && (
              <View style={s.reasoningLevels}>
                {reasoningVariants.map((v) => {
                  const active = v.id === reasoningSelected
                  return (
                    <Pressable
                      key={v.id}
                      onPress={() => onReasoningSelect(v.id)}
                      style={[
                        s.levelChip,
                        active
                          ? { backgroundColor: tokens.background, borderColor: tokens.border }
                          : { backgroundColor: tokens.muted, borderColor: tokens.border },
                      ]}
                    >
                      <Text style={[s.levelChipLabel, { color: active ? tokens.primary : tokens.mutedForeground }]}>
                        {v.label}
                      </Text>
                      {active && <Check size={14} color={tokens.primary} />}
                    </Pressable>
                  )
                })}
              </View>
            )}
            {reasoningAlwaysOn && (
              <Text style={[s.hint, { color: tokens.mutedForeground }]}>
                Este modelo sempre usa raciocínio extendido.
              </Text>
            )}
          </View>

          {/* Modo Plano */}
          <View style={[s.card, { borderColor: tokens.border }]}>
            <View style={s.cardRow}>
              <View style={s.cardRowLeft}>
                <FileText size={18} color={tokens.mutedForeground} />
                <Text style={[s.cardLabel, { color: tokens.foreground }]}>Modo Plano</Text>
              </View>
              <Switch
                value={plan}
                onValueChange={onPlanToggle}
                trackColor={{ false: tokens.muted, true: tokens.primary }}
                thumbColor={tokens.foreground}
              />
            </View>
            {plan && (
              <Text style={[s.hint, { color: tokens.mutedForeground }]}>
                Apenas ferramentas de leitura. O resultado é um plano de implementação (PLAN.md) revisável.
              </Text>
            )}
          </View>

          {/* Subagentes */}
          <View style={[s.card, { borderColor: tokens.border }]}>
            <View style={s.cardRow}>
              <View style={s.cardRowLeft}>
                <Bot size={18} color={tokens.mutedForeground} />
                <Text style={[s.cardLabel, { color: tokens.foreground }]}>Subagentes</Text>
              </View>
              <Switch
                value={subagents}
                onValueChange={onSubagentsToggle}
                trackColor={{ false: tokens.muted, true: tokens.primary }}
                thumbColor={tokens.foreground}
              />
            </View>
            {subagents && (
              <Pressable onPress={onConfigureWorkers} style={[s.modelCard, { backgroundColor: rowSelectedBg, borderColor: tokens.border }]}>
                <Bot size={16} color={tokens.primary} />
                <Text style={[s.modelCardLabel, { color: tokens.foreground }]}>
                  {workerModelLabel ?? 'Usar o mesmo modelo do chat'}
                </Text>
                <ChevronRight size={14} color={tokens.mutedForeground} />
              </Pressable>
            )}
          </View>

          {/* Orquestração */}
          <View style={[s.card, { borderColor: tokens.border }]}>
            <View style={s.cardRow}>
              <View style={s.cardRowLeft}>
                <Network size={18} color={tokens.mutedForeground} />
                <Text style={[s.cardLabel, { color: tokens.foreground }]}>Orquestração</Text>
              </View>
              <Switch
                value={orchestra}
                onValueChange={onOrchestraToggle}
                trackColor={{ false: tokens.muted, true: tokens.primary }}
                thumbColor={tokens.foreground}
              />
            </View>
            {orchestra && (
              <Pressable onPress={onConfigureWorkers} style={[s.modelCard, { backgroundColor: rowSelectedBg, borderColor: tokens.border }]}>
                <Network size={16} color={tokens.primary} />
                <Text style={[s.modelCardLabel, { color: tokens.foreground }]}>
                  {workerModelLabel ?? 'Usar o mesmo modelo do chat'}
                </Text>
                <ChevronRight size={14} color={tokens.mutedForeground} />
              </Pressable>
            )}
          </View>

          {/* Loop */}
          <View style={[s.card, { borderColor: tokens.border }]}>
            <View style={s.cardRow}>
              <View style={s.cardRowLeft}>
                <RefreshCw size={18} color={tokens.mutedForeground} />
                <Text style={[s.cardLabel, { color: tokens.foreground }]}>Loop</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {loop && onConfigureLoop && (
                  <Pressable onPress={onConfigureLoop} hitSlop={8} style={[s.gearBtn, { backgroundColor: tokens.muted }]}>
                    <Settings2 size={16} color={tokens.mutedForeground} />
                  </Pressable>
                )}
                <Switch
                  value={loop}
                  onValueChange={onLoopToggle}
                  trackColor={{ false: tokens.muted, true: tokens.primary }}
                  thumbColor={tokens.foreground}
                />
              </View>
            </View>
            {loop && (
              <Text style={[s.hint, { color: tokens.mutedForeground }]}>
                Agente revisa e itera até completar a tarefa.
              </Text>
            )}
          </View>
        </ScrollView>
      </Animated.View>
    </Modal>
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
    maxHeight: SHEET_HEIGHT,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  card: {
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    gap: 10,
    borderWidth: 1,
  },
  cardLabel: { fontSize: 14, fontWeight: '500' },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardRowLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  permissionRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  permissionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flex: 1,
    justifyContent: 'center',
    borderWidth: 1,
  },
  permissionChipLabel: { fontSize: 13, fontWeight: '500' },
  reasoningLevels: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  levelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
  },
  levelChipLabel: { fontSize: 13, fontWeight: '500' },
  hint: { fontSize: 11, opacity: 0.7 },
  modelCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
  },
  modelCardLabel: { fontSize: 13, fontWeight: '500', flex: 1 },
  gearBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
