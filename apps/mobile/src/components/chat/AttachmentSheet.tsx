import { useCallback, useEffect, useState, type ComponentType } from 'react'
import {
  Modal,
  View,
  Text,
  Pressable,
  Animated,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Camera,
  Image as ImageIcon,
  Paperclip,
  Settings2,
  ChevronLeft,
  ChevronRight,
  Brain,
  Shield,
  ShieldCheck,
  ShieldOff,
  GitBranch,
  Check,
  Wrench,
} from 'lucide-react-native'
import type { LucideIcon } from 'lucide-react-native'
import type { ModelVariant } from '@orbit/shared'
import { useTranslation } from 'react-i18next'
import { ProviderLogo } from '~/components/ui/provider-logo'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export type PermissionModeValue = 'ask' | 'approve' | 'full'

/** Icon component of a mode: the metadata lives in useChatModes, which does not know
 *  lucide's forwarded-ref type — any component taking size/color serves. */
export type ModeIcon = ComponentType<{ size?: number; color?: string }>

export interface ModeItem {
  id: string
  icon: ModeIcon
  label: string
  active: boolean
  onToggle: () => void
  onConfigure?: () => void
}

/** An MCP server of the app, as it enters this chat. */
export interface ToolItem {
  /** Server name — the id the backend slices by. */
  name: string
  /** Whether the server enters the context of this conversation. */
  active: boolean
  /** Connection state of the server in the app. */
  connected: boolean
}

/** Pages of the sheet, in the order the user walks through them. */
const PAGE_ATTACHMENTS = 0
const PAGE_MODES = 1
const PAGE_THINKING = 2
const PAGE_PERMISSIONS = 3
const PAGE_TOOLS = 4

type Page =
  | typeof PAGE_ATTACHMENTS
  | typeof PAGE_MODES
  | typeof PAGE_THINKING
  | typeof PAGE_PERMISSIONS
  | typeof PAGE_TOOLS

/** Height of the content of each page: the sheet grows while the pages slide. */
const PAGE_HEIGHT: Record<Page, number> = {
  [PAGE_ATTACHMENTS]: 444,
  [PAGE_MODES]: 500,
  [PAGE_THINKING]: 420,
  [PAGE_PERMISSIONS]: 300,
  [PAGE_TOOLS]: 420,
}

/** Off-screen offset of the entrance/exit animation — bigger than any page. */
const SHEET_HEIGHT = 560

/** Travel of the knob inside the 44px track (44 - 6 of padding - 20 of knob). */
const SWITCH_KNOB_OFFSET = 18

const PERMISSION_ICON: Record<PermissionModeValue, LucideIcon> = {
  ask: Shield,
  approve: ShieldCheck,
  full: ShieldOff,
}

const PERMISSION_LABEL_KEY: Record<PermissionModeValue, string> = {
  ask: 'configSheet.permissionModes.ask',
  approve: 'configSheet.permissionModes.approve',
  full: 'configSheet.permissionModes.full',
}

interface AttachmentSheetProps {
  visible: boolean
  onClose: () => void
  onCamera: () => void
  onPhotos: () => void
  onFiles: () => void
  /** Name of the model of this chat — the row opens the picker. */
  modelLabel: string
  modelProviderId?: string
  onOpenModel: () => void
  /** Every mode of the chat: the settings page turns each one on and off. */
  modes: ModeItem[]
  /** MCP servers of the chat: the tools page turns each one on and off. */
  tools: ToolItem[]
  onToolToggle: (name: string) => void
  thinking: boolean
  reasoningVariants: ModelVariant[]
  reasoningSelected?: string
  reasoningAlwaysOn?: boolean
  onThinkingOff: () => void
  onReasoningSelect: (variantId: string) => void
  permissionMode: PermissionModeValue
  onPermissionModeChange: (mode: PermissionModeValue) => void
  gitBranches?: string[]
  gitCurrent?: string
  onGitBranchChange?: (branch: string) => void
  gitBranchLoading?: boolean
}

/**
 * The "+" of the composer. First page: the three attachments and the chat level
 * settings (model, thinking, permissions); "Settings" slides to the modes, the
 * mode rows slide to the list of reasoning levels and to the permission levels.
 */
export function AttachmentSheet({
  visible,
  onClose,
  onCamera,
  onPhotos,
  onFiles,
  modelLabel,
  modelProviderId,
  onOpenModel,
  modes,
  tools,
  onToolToggle,
  thinking,
  reasoningVariants,
  reasoningSelected,
  reasoningAlwaysOn,
  onThinkingOff,
  onReasoningSelect,
  permissionMode,
  onPermissionModeChange,
  gitBranches,
  gitCurrent,
  onGitBranchChange,
  gitBranchLoading,
}: AttachmentSheetProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()
  const { width: screenWidth } = useWindowDimensions()

  // Width of the page viewport, measured on layout: the padding and the border of the
  // sheet make it 2px narrower than `screenWidth - 32`, and those 2px are enough for the
  // second page to peek at the right edge. The subtraction below is only the first frame.
  const [innerWidth, setInnerWidth] = useState(Math.max(1, screenWidth - 34))
  const [page, setPage] = useState<Page>(PAGE_ATTACHMENTS)

  const [slideAnim] = useState(() => new Animated.Value(SHEET_HEIGHT))
  const [backdropAnim] = useState(() => new Animated.Value(0))
  const [pageFade] = useState(() => new Animated.Value(1))
  const [heightAnim] = useState(() => new Animated.Value(PAGE_HEIGHT[PAGE_ATTACHMENTS]))

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

  useEffect(() => {
    // Only the page on screen is mounted: the sheet fades the new one in and never
    // travels across the others. The height is a layout property and cannot go with the
    // native driver, hence the two animations on two different nodes.
    pageFade.setValue(0)
    Animated.parallel([
      Animated.timing(pageFade, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(heightAnim, {
        toValue: PAGE_HEIGHT[page],
        duration: 220,
        useNativeDriver: false,
      }),
    ]).start()
  }, [page, pageFade, heightAnim])

  // Back to the attachments on every exit: the next "+" opens on the first page.
  const closeSheet = useCallback(() => {
    setPage(PAGE_ATTACHMENTS)
    onClose()
  }, [onClose])

  const backToAttachments = useCallback(() => setPage(PAGE_ATTACHMENTS), [])

  const selectedVariant = reasoningVariants.find((v) => v.id === reasoningSelected)
  const thinkingLabel = thinking
    ? (selectedVariant?.label ?? t('attachment.on'))
    : t('attachment.off')

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={closeSheet}>
      <Animated.View style={[s.backdrop, { opacity: backdropAnim }]}>
        <Pressable style={{ flex: 1 }} onPress={closeSheet} />
      </Animated.View>

      {/* Two animated nodes on purpose: `translateY` runs on the native driver and `height`
          cannot (it is a layout property). On the same node the native module rejects
          `height`, and the JS animation is refused on a node already moved to native. */}
      <Animated.View
        style={[
          s.sheet,
          {
            paddingBottom: insets.bottom + 12,
            transform: [{ translateY: slideAnim }],
            backgroundColor: tokens.card,
            borderColor: tokens.border,
          },
        ]}
      >
        <Animated.View style={{ height: heightAnim }}>
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />

          <View
            style={{ flex: 1, overflow: 'hidden' }}
            onLayout={(e) => setInnerWidth(Math.round(e.nativeEvent.layout.width))}
          >
            <Animated.View
              style={{
                height: '100%',
                width: innerWidth,
                opacity: pageFade,
              }}
            >
              {/* ── Attachments, model, thinking, permissions ─────────────────── */}
              {page === PAGE_ATTACHMENTS && (
                // Rola: a altura da página é uma meta, não um limite — com fonte maior (ou
                // tela pequena) as últimas linhas eram cortadas no rodapé e "Modos"/
                // "Ferramentas" simplesmente não apareciam.
                <ScrollView
                  style={{ width: innerWidth, height: '100%' }}
                  contentContainerStyle={{ paddingBottom: 8 }}
                  showsVerticalScrollIndicator={false}
                >
                  <View style={[s.actionsRow, { borderBottomColor: tokens.border }]}>
                  <SheetAction
                    icon={Camera}
                    label={t('attachment.camera')}
                    color={tokens.foreground}
                    background={tokens.muted}
                    onPress={onCamera}
                  />
                  <SheetAction
                    icon={ImageIcon}
                    label={t('attachment.photos')}
                    color={tokens.foreground}
                    background={tokens.muted}
                    onPress={onPhotos}
                  />
                  <SheetAction
                    icon={Paperclip}
                    label={t('attachment.files')}
                    color={tokens.foreground}
                    background={tokens.muted}
                    onPress={onFiles}
                  />
                </View>

                <View style={s.rows}>
                  <SheetRow
                    tokens={tokens}
                    leading={
                      modelProviderId ? (
                        <ProviderLogo
                          providerId={modelProviderId}
                          size={20}
                          color={tokens.mutedForeground}
                        />
                      ) : (
                        <Brain size={20} color={tokens.mutedForeground} />
                      )
                    }
                    label={t('attachment.model')}
                    value={modelLabel}
                    onPress={onOpenModel}
                  />
                  <SheetRow
                    tokens={tokens}
                    leading={<Brain size={20} color={tokens.mutedForeground} />}
                    label={t('attachment.thinking')}
                    value={thinkingLabel}
                    onPress={() => setPage(PAGE_THINKING)}
                  />
                  <SheetRow
                    tokens={tokens}
                    leading={<ShieldCheck size={20} color={tokens.mutedForeground} />}
                    label={t('attachment.permissions')}
                    value={t(PERMISSION_LABEL_KEY[permissionMode])}
                    onPress={() => setPage(PAGE_PERMISSIONS)}
                  />
                  <SheetRow
                    tokens={tokens}
                    leading={<Settings2 size={20} color={tokens.mutedForeground} />}
                    label={t('attachment.modes')}
                    value={t('attachment.activeCount', {
                      count: modes.filter((mode) => mode.active).length,
                    })}
                    onPress={() => setPage(PAGE_MODES)}
                  />
                  <SheetRow
                    tokens={tokens}
                    leading={<Wrench size={20} color={tokens.mutedForeground} />}
                    label={t('attachment.tools')}
                    value={t('attachment.activeCount', {
                      count: tools.filter((tool) => tool.active).length,
                    })}
                    onPress={() => setPage(PAGE_TOOLS)}
                  />
                </View>
                </ScrollView>
              )}

              {/* ── Modes ─────────────────────────────────────────────────────── */}
              {page === PAGE_MODES && (
              <View style={{ width: innerWidth, height: '100%' }}>
                <PageHeader
                  title={t('attachment.modes')}
                  onBack={backToAttachments}
                  color={tokens.foreground}
                  trailing={t('attachment.activeCount', {
                    count: modes.filter((mode) => mode.active).length,
                  })}
                  mutedColor={tokens.mutedForeground}
                />

                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
                  showsVerticalScrollIndicator={false}
                >
                  {modes.map((mode) => (
                    <ModeRow
                      key={mode.id}
                      mode={mode}
                      tokens={tokens}
                      onConfigure={mode.onConfigure}
                    />
                  ))}

                  {gitBranches && gitBranches.length > 0 && (
                    <View style={s.branchBlock}>
                      <View style={s.branchTitle}>
                        <GitBranch size={16} color={tokens.mutedForeground} />
                        <Text style={[s.branchLabel, { color: tokens.mutedForeground }]}>
                          {t('attachment.branch')}
                        </Text>
                      </View>
                      {gitBranchLoading ? (
                        <ActivityIndicator size="small" color={tokens.primary} />
                      ) : (
                        <View style={s.branchChips}>
                          {gitBranches.map((branch) => {
                            const active = branch === gitCurrent
                            return (
                              <Pressable
                                key={branch}
                                onPress={() => onGitBranchChange?.(branch)}
                                style={[
                                  s.branchChip,
                                  {
                                    backgroundColor: tokens.muted,
                                    borderColor: active ? tokens.primary : tokens.border,
                                  },
                                ]}
                              >
                                <Text
                                  style={[
                                    s.branchChipLabel,
                                    { color: active ? tokens.primary : tokens.mutedForeground },
                                  ]}
                                >
                                  {branch}
                                </Text>
                                {active && <Check size={14} color={tokens.primary} />}
                              </Pressable>
                            )
                          })}
                        </View>
                      )}
                    </View>
                  )}
                </ScrollView>
              </View>
              )}

              {/* ── Thinking levels ───────────────────────────────────────────── */}
              {page === PAGE_THINKING && (
              <View style={{ width: innerWidth, height: '100%' }}>
                <PageHeader
                  title={t('attachment.thinking')}
                  onBack={backToAttachments}
                  color={tokens.foreground}
                />

                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
                  showsVerticalScrollIndicator={false}
                >
                  <OptionRow
                    label={t('attachment.off')}
                    selected={!thinking}
                    disabled={reasoningAlwaysOn}
                    tokens={tokens}
                    onPress={onThinkingOff}
                  />
                  {reasoningVariants.map((variant) => (
                    <OptionRow
                      key={variant.id}
                      label={variant.label}
                      hint={variant.description}
                      selected={thinking && reasoningSelected === variant.id}
                      tokens={tokens}
                      onPress={() => onReasoningSelect(variant.id)}
                    />
                  ))}
                  {reasoningAlwaysOn && (
                    <Text style={[s.hint, { color: tokens.mutedForeground }]}>
                      {t('configSheet.reasoningAlwaysOnHint')}
                    </Text>
                  )}
                </ScrollView>
              </View>
              )}

              {/* ── Permission levels ─────────────────────────────────────────── */}
              {page === PAGE_PERMISSIONS && (
              <View style={{ width: innerWidth, height: '100%' }}>
                <PageHeader
                  title={t('attachment.permissions')}
                  onBack={backToAttachments}
                  color={tokens.foreground}
                />

                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
                  showsVerticalScrollIndicator={false}
                >
                  {(Object.keys(PERMISSION_ICON) as PermissionModeValue[]).map((mode) => (
                    <OptionRow
                      key={mode}
                      label={t(PERMISSION_LABEL_KEY[mode])}
                      icon={PERMISSION_ICON[mode]}
                      selected={permissionMode === mode}
                      tokens={tokens}
                      onPress={() => onPermissionModeChange(mode)}
                    />
                  ))}
                </ScrollView>
              </View>
              )}

              {/* ── Tools (MCP servers of this chat) ───────────────────────────── */}
              {page === PAGE_TOOLS && (
              <View style={{ width: innerWidth, height: '100%' }}>
                <PageHeader
                  title={t('attachment.tools')}
                  onBack={backToAttachments}
                  color={tokens.foreground}
                  trailing={t('attachment.activeCount', {
                    count: tools.filter((tool) => tool.active).length,
                  })}
                  mutedColor={tokens.mutedForeground}
                />

                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
                  showsVerticalScrollIndicator={false}
                >
                  {tools.length === 0 ? (
                    <Text style={[s.hint, { color: tokens.mutedForeground }]}>
                      {t('attachment.noTools')}
                    </Text>
                  ) : (
                    tools.map((tool) => (
                      <ToolRow
                        key={tool.name}
                        tool={tool}
                        tokens={tokens}
                        onToggle={() => onToolToggle(tool.name)}
                      />
                    ))
                  )}
                </ScrollView>
              </View>
              )}
            </Animated.View>
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  )
}

type Tokens = ReturnType<typeof getThemeTokens>

function PageHeader({
  title,
  onBack,
  color,
  trailing,
  mutedColor,
}: {
  title: string
  onBack: () => void
  color: string
  /** Grey text at the right end — the title stays on the left, pushed apart. */
  trailing?: string
  mutedColor?: string
}) {
  return (
    <View style={s.pageHeader}>
      {/* 44x44 of real touch area — the chevron alone is a 12px target */}
      <Pressable onPress={onBack} style={s.backButton} hitSlop={4}>
        <ChevronLeft size={28} color={color} />
      </Pressable>
      <Text style={[s.pageTitle, { color }]}>{title}</Text>
      <View style={{ flex: 1 }} />
      {trailing ? (
        <Text style={[s.pageTrailing, { color: mutedColor ?? color }]}>{trailing}</Text>
      ) : null}
    </View>
  )
}

function SheetAction({
  icon: Icon,
  label,
  color,
  background,
  onPress,
}: {
  icon: LucideIcon
  label: string
  color: string
  background: string
  onPress: () => void
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.action, { opacity: pressed ? 0.7 : 1 }]}>
      <View style={[s.actionCircle, { backgroundColor: background }]}>
        <Icon size={24} color={color} />
      </View>
      <Text style={[s.actionLabel, { color }]}>{label}</Text>
    </Pressable>
  )
}

function SheetRow({
  tokens,
  leading,
  label,
  value,
  onPress,
}: {
  tokens: Tokens
  leading: React.ReactNode
  label: string
  value?: string
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        s.row,
        { backgroundColor: tokens.muted, opacity: pressed ? 0.75 : 1 },
      ]}
    >
      <View style={s.rowLeading}>{leading}</View>
      <Text style={[s.rowLabel, { color: tokens.foreground }]} numberOfLines={1}>
        {label}
      </Text>
      {value ? (
        <Text style={[s.rowValue, { color: tokens.mutedForeground }]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      <ChevronRight size={20} color={tokens.mutedForeground} />
    </Pressable>
  )
}

function ModeRow({
  mode,
  tokens,
  onConfigure,
}: {
  mode: ModeItem
  tokens: Tokens
  onConfigure?: () => void
}) {
  const Icon = mode.icon
  return (
    <Pressable
      onPress={mode.onToggle}
      onLongPress={mode.active ? onConfigure : undefined}
      style={[
        s.row,
        {
          backgroundColor: tokens.muted,
          borderColor: mode.active ? tokens.primary : 'transparent',
          borderWidth: 1,
        },
      ]}
    >
      <View style={s.rowLeading}>
        <Icon size={20} color={mode.active ? tokens.primary : tokens.mutedForeground} />
      </View>
      <Text
        style={[s.rowLabel, { color: mode.active ? tokens.foreground : tokens.mutedForeground }]}
        numberOfLines={1}
      >
        {mode.label}
      </Text>
      {mode.active && onConfigure ? (
        <Pressable onPress={onConfigure} hitSlop={10} style={{ padding: 4 }}>
          <Settings2 size={18} color={tokens.mutedForeground} />
        </Pressable>
      ) : null}
      <View
        style={[
          s.checkBox,
          {
            borderColor: mode.active ? tokens.primary : tokens.mutedForeground,
            backgroundColor: mode.active ? tokens.primary : 'transparent',
          },
        ]}
      >
        {mode.active && <Check size={14} color={tokens.primaryForeground} />}
      </View>
    </Pressable>
  )
}

function ToolRow({
  tool,
  tokens,
  onToggle,
}: {
  tool: ToolItem
  tokens: Tokens
  onToggle: () => void
}) {
  return (
    <Pressable
      onPress={onToggle}
      style={[s.row, { backgroundColor: tokens.muted, borderColor: 'transparent', borderWidth: 1 }]}
    >
      {/* Dot of the connection state of the server in the app */}
      <View
        style={[
          s.toolDot,
          { backgroundColor: tool.connected ? tokens.primary : tokens.mutedForeground },
        ]}
      />
      <Text
        style={[
          s.rowLabel,
          { flex: 1, color: tool.active ? tokens.foreground : tokens.mutedForeground },
        ]}
        numberOfLines={1}
      >
        {tool.name}
      </Text>
      <View
        style={[
          s.switchTrack,
          { backgroundColor: tool.active ? tokens.primary : tokens.border },
        ]}
      >
        <View
          style={[
            s.switchKnob,
            {
              backgroundColor: tool.active ? tokens.primaryForeground : tokens.mutedForeground,
              transform: [{ translateX: tool.active ? SWITCH_KNOB_OFFSET : 0 }],
            },
          ]}
        />
      </View>
    </Pressable>
  )
}

function OptionRow({
  label,
  hint,
  icon: Icon,
  selected,
  disabled,
  tokens,
  onPress,
}: {
  label: string
  hint?: string
  icon?: LucideIcon
  selected: boolean
  disabled?: boolean
  tokens: Tokens
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        s.row,
        {
          backgroundColor: tokens.muted,
          borderColor: selected ? tokens.primary : 'transparent',
          borderWidth: 1,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      {Icon ? (
        <View style={s.rowLeading}>
          <Icon size={20} color={selected ? tokens.primary : tokens.mutedForeground} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text
          style={[s.rowLabel, { color: selected ? tokens.foreground : tokens.mutedForeground }]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {hint ? (
          <Text style={[s.rowHint, { color: tokens.mutedForeground }]} numberOfLines={2}>
            {hint}
          </Text>
        ) : null}
      </View>
      {selected && <Check size={18} color={tokens.primary} />}
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
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    paddingTop: 10,
    paddingHorizontal: 16,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 14,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingBottom: 14,
    marginBottom: 12,
    borderBottomWidth: 1,
  },
  action: { alignItems: 'center', gap: 8, flex: 1 },
  actionCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { fontSize: 12, fontWeight: '500' },
  rows: { gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 14,
  },
  rowLeading: { width: 22, alignItems: 'center' },
  rowLabel: { fontSize: 15, fontWeight: '500', flexShrink: 1 },
  rowValue: { fontSize: 13, marginLeft: 'auto' },
  rowHint: { fontSize: 12, marginTop: 2 },
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingBottom: 10,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -8,
  },
  pageTitle: { fontSize: 16, fontWeight: '600' },
  pageTrailing: { fontSize: 13, fontWeight: '600', marginRight: 4 },
  checkBox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 'auto',
  },
  toolDot: { width: 8, height: 8, borderRadius: 4 },
  switchTrack: {
    width: 44,
    height: 26,
    borderRadius: 13,
    padding: 3,
    justifyContent: 'center',
  },
  switchKnob: { width: 20, height: 20, borderRadius: 10 },
  hint: { fontSize: 12, lineHeight: 17, paddingHorizontal: 4, paddingTop: 4 },
  branchBlock: { gap: 8, paddingTop: 8 },
  branchTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  branchLabel: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  branchChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  branchChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  branchChipLabel: { fontSize: 13, fontWeight: '500' },
})
