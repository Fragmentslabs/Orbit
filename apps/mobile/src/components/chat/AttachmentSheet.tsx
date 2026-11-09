import { useCallback, useEffect, useState, type ComponentType } from 'react'
import {
  Modal,
  View,
  Text,
  Pressable,
  Animated,
  ActivityIndicator,
  StyleSheet,
  ScrollView,
  Keyboard,
  Platform,
  useWindowDimensions,
} from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Camera,
  Image as ImageIcon,
  Paperclip,
  Settings2,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Brain,
  Shield,
  ShieldCheck,
  ShieldOff,
  Check,
  Wrench,
  Folder,
  GitBranch,
  Info,
  Plus,
  X,
} from 'lucide-react-native'
import type { LucideIcon } from 'lucide-react-native'
import type { BranchesResponse, ModelVariant } from '@orbit/shared'
import { useTranslation } from 'react-i18next'
import { ProviderLogo } from '~/components/ui/provider-logo'
import { useConnectionStore } from '~/stores/connection-store'
import { folderName } from '~/lib/folder-name'
import { saveRecentFolder } from '~/lib/folder-recents'
import { useBottomBreathing } from '~/lib/keyboard'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { DirBrowserBody } from './DirBrowserBody'
import { ModelPickerContent } from './ModelPickerModal'

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
const PAGE_FOLDERS = 5
const PAGE_BROWSE = 6
const PAGE_MODEL = 7

type Page =
  | typeof PAGE_ATTACHMENTS
  | typeof PAGE_MODES
  | typeof PAGE_THINKING
  | typeof PAGE_PERMISSIONS
  | typeof PAGE_TOOLS
  | typeof PAGE_FOLDERS
  | typeof PAGE_BROWSE
  | typeof PAGE_MODEL

/** Height of the content of each page: the sheet grows while the pages slide. */
const PAGE_HEIGHT: Record<Page, number> = {
  // Taller on purpose: in a code chat the page has six rows plus the three action
  // buttons, and all of it has to fit without scrolling.
  [PAGE_ATTACHMENTS]: 520,
  [PAGE_MODES]: 500,
  [PAGE_THINKING]: 420,
  [PAGE_PERMISSIONS]: 300,
  [PAGE_TOOLS]: 420,
  [PAGE_FOLDERS]: 460,
  [PAGE_BROWSE]: 500,
  [PAGE_MODEL]: 500,
}

/** Off-screen offset of the entrance/exit animation — bigger than any page plus the
 *  sheet's own padding and the safe area of the home indicator. */
const SHEET_HEIGHT = 640

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
  /** Name of the model of this chat — the row opens the picker page. */
  modelLabel: string
  modelProviderId?: string
  /** Session that owns the model choice — undefined/null = draft. */
  sessionId?: string | null
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
  /** Code mode: folders of the chat, main first — the "Folder & branch" page. */
  folders?: string[]
  onFoldersChange?: (folders: string[]) => void
  /** Opens straight on the folder page (the folder strip of the header). */
  startOnFolders?: boolean
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
  sessionId,
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
  folders,
  onFoldersChange,
  startOnFolders,
}: AttachmentSheetProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()
  const { width: screenWidth, height: screenHeight } = useWindowDimensions()

  // Width of the page viewport, measured on layout: the padding and the border of the
  // sheet make it 2px narrower than `screenWidth - 32`, and those 2px are enough for the
  // second page to peek at the right edge. The subtraction below is only the first frame.
  const [innerWidth, setInnerWidth] = useState(Math.max(1, screenWidth - 34))
  const [page, setPage] = useState<Page>(PAGE_ATTACHMENTS)

  // The sheet is a Modal: the keyboard would cover it whole, and the lift belongs to the
  // KeyboardAvoidingView of react-native-keyboard-controller (same convention as the
  // ChatScreen). The height read here only caps the body of the page below.
  const [kbHeight, setKbHeight] = useState(0)

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => setKbHeight(e.endCoordinates.height),
    )
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKbHeight(0),
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  // Foot of the sheet, the same convention as the chat input (lib/keyboard): the padding
  // is FIXED and the same value goes to the KAV as a negative `keyboardVerticalOffset`,
  // so the keyboard lifts the drawer by (height - padding). While it is open that
  // padding ends up behind the keyboard — the body reaches the keyboard with no dead
  // margin — and on the way back the 46px come out with the keyboard's own animation
  // instead of being added after it ends (one animation, in phase, no flick).
  const sheetBottomPad = useBottomBreathing() + 12

  // The keyboard is up only in the pages with an input (the model search): the drawer
  // cannot pass the status bar, so the body shrinks and the page's ScrollView/List takes
  // over (18 = the sheet's paddingTop plus breathing room). Open, the bottom padding is
  // under the keyboard and does not count.
  const pageMaxHeight = Math.max(
    240,
    screenHeight - kbHeight - insets.top - (kbHeight > 0 ? 0 : sheetBottomPad) - 18,
  )

  // Body height of the moment: the page's own height, capped by the space available.
  const bodyHeight = Math.min(PAGE_HEIGHT[page], pageMaxHeight)

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
    // travels across the others.
    pageFade.setValue(0)
    Animated.timing(pageFade, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start()
  }, [page, pageFade])

  useEffect(() => {
    // The opening fades the page in again. The fade started on the way out is lost when
    // the sheet closes, and on the next opening `page` is already back to the attachments
    // — it does not change, so the effect above never runs again and the sheet came back
    // as a bare gray card, page at opacity 0.
    if (!visible || startOnFolders) return
    pageFade.setValue(0)
    Animated.timing(pageFade, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start()
  }, [visible, startOnFolders, pageFade])

  useEffect(() => {
    // The body follows the page AND the keyboard: shrinking on the way in and growing on
    // the way out in one animation, never snapping when the closing finishes. `height` is
    // a layout property and cannot go with the native driver, hence its own JS node.
    Animated.timing(heightAnim, {
      toValue: bodyHeight,
      duration: 220,
      useNativeDriver: false,
    }).start()
  }, [bodyHeight, heightAnim])

  // Back to the attachments on every exit: the next "+" opens on the first page.
  const closeSheet = useCallback(() => {
    Keyboard.dismiss()
    setPage(PAGE_ATTACHMENTS)
    onClose()
  }, [onClose])

  const backToAttachments = useCallback(() => {
    Keyboard.dismiss()
    setPage(PAGE_ATTACHMENTS)
  }, [])

  const wsClient = useConnectionStore((s) => s.wsClient)
  const [browseTarget, setBrowseTarget] = useState<'main' | 'extra'>('main')
  const [branchOpen, setBranchOpen] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [branchCurrent, setBranchCurrent] = useState('')
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [branchSwitching, setBranchSwitching] = useState<string | null>(null)

  const mainFolder = folders?.[0]
  const extras = folders?.slice(1) ?? []
  const workspaceLabel = mainFolder
    ? `${folderName(mainFolder)}${extras.length > 0 ? ` •${extras.length}` : ''}`
    : t('folderSelector.associateFolder')

  // The folder strip of the header opens the sheet straight on the folder page.
  useEffect(() => {
    if (!visible || !startOnFolders) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(PAGE_FOLDERS)
  }, [visible, startOnFolders])

  useEffect(() => {
    if (!mainFolder || page !== PAGE_FOLDERS) return
    let cancelled = false
    // The current branch shows before the list expands, so it is read as soon as the
    // page opens; switching goes through the same git call the branch sheet used.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBranchLoading(true)
    setBranchError(null)
    const run = async () => {
      try {
        const res = await wsClient.send({ type: 'git:branches', directory: mainFolder })
        if (cancelled) return
        if (res.ok && res.data) {
          const data = res.data as BranchesResponse
          setBranches(data.branches)
          setBranchCurrent(data.current)
        } else {
          setBranchError(res.error ?? t('branch.loadError'))
        }
      } catch (err) {
        if (!cancelled) setBranchError(String(err))
      } finally {
        if (!cancelled) setBranchLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [mainFolder, page, wsClient, t])

  const handlePicked = useCallback(
    (path: string) => {
      void saveRecentFolder(path)
      if (browseTarget === 'main') {
        if (folders && folders[0] !== path) {
          onFoldersChange?.([path, ...folders.filter((f) => f !== path)])
        }
      } else if (folders && !folders.includes(path)) {
        onFoldersChange?.([...folders, path])
      }
      setPage(PAGE_FOLDERS)
    },
    [browseTarget, folders, onFoldersChange],
  )

  const removeExtra = (path: string) => {
    if (!folders) return
    onFoldersChange?.(folders.filter((f) => f !== path))
  }

  const checkout = async (branch: string) => {
    if (!mainFolder) return
    if (branch === branchCurrent) {
      setBranchOpen(false)
      return
    }
    setBranchSwitching(branch)
    setBranchError(null)
    try {
      const res = await wsClient.send({ type: 'git:checkout', directory: mainFolder, branch })
      if (res.ok) {
        setBranchCurrent(branch)
        setBranchOpen(false)
      } else {
        setBranchError(res.error ?? t('branch.switchError'))
      }
    } catch (err) {
      setBranchError(String(err))
    } finally {
      setBranchSwitching(null)
    }
  }

  const selectedVariant = reasoningVariants.find((v) => v.id === reasoningSelected)
  const thinkingLabel = thinking
    ? (selectedVariant?.label ?? t('attachment.on'))
    : t('attachment.off')

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={closeSheet}>
      {/* KAV of react-native-keyboard-controller: the sheet is a Modal, so without it the
          keyboard opens over the drawer instead of pushing it (same as the ChatScreen). */}
      <KeyboardAvoidingView
        behavior="padding"
        keyboardVerticalOffset={-sheetBottomPad}
        style={s.overlay}
      >
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
              paddingBottom: sheetBottomPad,
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
                    {/* Folder + branch of the chat: a page of this same sheet, like the
                        modes and the permissions (code mode only). */}
                    {folders !== undefined && (
                      <SheetRow
                        tokens={tokens}
                        leading={<Folder size={20} color={tokens.mutedForeground} />}
                        label={t('workspace.title')}
                        value={workspaceLabel}
                        onPress={() => setPage(PAGE_FOLDERS)}
                      />
                    )}
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
                      onPress={() => setPage(PAGE_MODEL)}
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

                {/* ── Folder & branch (page, like modes and permissions) ──────────── */}
                {page === PAGE_FOLDERS && (
                <View style={{ width: innerWidth, height: '100%' }}>
                  <PageHeader
                    title={t('workspace.title')}
                    onBack={backToAttachments}
                    color={tokens.foreground}
                  />

                  <ScrollView
                    style={{ flex: 1 }}
                    contentContainerStyle={{ paddingBottom: 8 }}
                    showsVerticalScrollIndicator={false}
                  >
                    <Text style={[s.sectLabel, { color: tokens.mutedForeground }]}>
                      {t('workspace.main')}
                    </Text>
                    <Pressable
                      onPress={() => {
                        setBrowseTarget('main')
                        setPage(PAGE_BROWSE)
                      }}
                      style={s.wsRow}
                    >
                      <Folder size={18} color={tokens.mutedForeground} />
                      <View style={s.wsRowText}>
                        <Text style={[s.wsName, { color: tokens.foreground }]} numberOfLines={1}>
                          {mainFolder ? folderName(mainFolder) : t('folderSelector.associateFolder')}
                        </Text>
                        {mainFolder ? (
                          <Text style={[s.wsPath, { color: tokens.mutedForeground }]} numberOfLines={1}>
                            {mainFolder}
                          </Text>
                        ) : null}
                      </View>
                      <ChevronRight size={16} color={tokens.mutedForeground} />
                    </Pressable>

                    <Text style={[s.sectLabel, { color: tokens.mutedForeground }]}>
                      {extras.length > 0
                        ? `${t('workspace.additional')} · ${extras.length}`
                        : t('workspace.additional')}
                    </Text>
                    {extras.map((path) => (
                      <View key={path} style={s.wsRow}>
                        <Folder size={18} color={tokens.mutedForeground} />
                        <View style={s.wsRowText}>
                          <Text style={[s.wsName, { color: tokens.foreground }]} numberOfLines={1}>
                            {folderName(path)}
                          </Text>
                          <Text style={[s.wsPath, { color: tokens.mutedForeground }]} numberOfLines={1}>
                            {path}
                          </Text>
                        </View>
                        <Pressable onPress={() => removeExtra(path)} hitSlop={10} style={{ padding: 4 }}>
                          <X size={16} color={tokens.mutedForeground} />
                        </Pressable>
                      </View>
                    ))}
                    <Pressable
                      onPress={() => {
                        setBrowseTarget('extra')
                        setPage(PAGE_BROWSE)
                      }}
                      style={s.wsRow}
                    >
                      <View style={[s.wsPlus, { borderColor: tokens.border }]}>
                        <Plus size={13} color={tokens.mutedForeground} />
                      </View>
                      <Text style={[s.wsAdd, { color: tokens.mutedForeground }]}>
                        {t('workspace.addFolder')}
                      </Text>
                    </Pressable>

                    <View style={[s.wsDivider, { backgroundColor: tokens.border }]} />

                    <Text style={[s.sectLabel, { color: tokens.mutedForeground }]}>
                      {t('workspace.branch')}
                    </Text>
                    <Pressable onPress={() => setBranchOpen((o) => !o)} style={s.wsRow}>
                      <GitBranch size={18} color={tokens.mutedForeground} />
                      <Text style={[s.wsBranch, { color: tokens.foreground }]} numberOfLines={1}>
                        {branchCurrent || (branchLoading ? '…' : '—')}
                      </Text>
                      {branchOpen ? (
                        <ChevronUp size={15} color={tokens.mutedForeground} />
                      ) : (
                        <ChevronDown size={15} color={tokens.mutedForeground} />
                      )}
                    </Pressable>

                    {branchOpen && (
                      <View style={s.wsBranchList}>
                        {branchLoading ? (
                          <View style={{ paddingVertical: 14, alignItems: 'center' }}>
                            <ActivityIndicator color={tokens.primary} />
                          </View>
                        ) : branches.length === 0 ? (
                          <Text style={[s.hint, { color: tokens.mutedForeground }]}>
                            {t('branch.none')}
                          </Text>
                        ) : (
                          branches.map((branch) => {
                            const active = branch === branchCurrent
                            return (
                              <Pressable
                                key={branch}
                                onPress={() => void checkout(branch)}
                                style={s.wsBranchRow}
                              >
                                <GitBranch size={14} color={tokens.mutedForeground} />
                                <Text
                                  style={[
                                    s.wsBranchItem,
                                    { color: active ? tokens.foreground : tokens.mutedForeground },
                                    active && { fontWeight: '600' },
                                  ]}
                                  numberOfLines={1}
                                >
                                  {branch}
                                </Text>
                                {branchSwitching === branch ? (
                                  <ActivityIndicator size="small" color={tokens.primary} />
                                ) : active ? (
                                  <Check size={15} color={tokens.primary} />
                                ) : null}
                              </Pressable>
                            )
                          })
                        )}
                      </View>
                    )}

                    {branchError ? (
                      <Text style={[s.hint, { color: tokens.destructive }]}>{branchError}</Text>
                    ) : null}

                    <View style={s.wsNote}>
                      <Info size={14} color={tokens.mutedForeground} style={{ marginTop: 1 }} />
                      <Text style={[s.wsNoteText, { color: tokens.mutedForeground }]}>
                        {t('workspace.note')}
                      </Text>
                    </View>
                  </ScrollView>
                </View>
                )}

                {/* ── Folder browser (the system folders, inside the sheet) ───────── */}
                {page === PAGE_BROWSE && (
                <View style={{ width: innerWidth, height: '100%' }}>
                  <PageHeader
                    title={t('folderSelector.selectFolderTitle')}
                    onBack={() => setPage(PAGE_FOLDERS)}
                    color={tokens.foreground}
                  />
                  <DirBrowserBody active onPick={handlePicked} />
                </View>
                )}

                {/* ── Model picker (the drawer's body, as a page of this same sheet) ── */}
                {page === PAGE_MODEL && (
                <View style={{ width: innerWidth, height: '100%' }}>
                  <PageHeader
                    title={t('modelPickerModal.title')}
                    onBack={backToAttachments}
                    color={tokens.foreground}
                  />
                  <ModelPickerContent onClose={backToAttachments} sessionId={sessionId} inline />
                </View>
                )}
              </Animated.View>
            </View>
          </Animated.View>
        </Animated.View>
      </KeyboardAvoidingView>
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
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
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

  // Folder & branch page — the sections of the desktop's workspace menu.
  sectLabel: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    paddingTop: 14,
    paddingBottom: 4,
  },
  wsRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 2 },
  wsRowText: { flex: 1, minWidth: 0, gap: 1 },
  wsName: { fontSize: 14, fontWeight: '600' },
  wsPath: { fontSize: 10.5, fontFamily: 'monospace' },
  wsPlus: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -2,
  },
  wsAdd: { fontSize: 13 },
  wsDivider: { height: 1, marginTop: 10 },
  wsBranch: { flex: 1, minWidth: 0, fontSize: 13, fontFamily: 'monospace' },
  wsBranchList: { paddingLeft: 30, paddingBottom: 2 },
  wsBranchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 40 },
  wsBranchItem: { flex: 1, minWidth: 0, fontSize: 13, fontFamily: 'monospace' },
  wsNote: { flexDirection: 'row', gap: 8, paddingTop: 14, paddingBottom: 4 },
  wsNoteText: { flex: 1, fontSize: 11.5, lineHeight: 17 },
})
