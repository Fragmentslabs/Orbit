import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { View, Pressable, StyleSheet, Text, Animated } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Menu, Ellipsis, Pencil, Pin, PinOff, Archive, ArchiveRestore, GitFork, GitBranch, Search, Trash2, Folder, ChevronDown } from 'lucide-react-native'
import type { SessionInfo, BranchesResponse } from '@orbit/shared'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useConnectionStore } from '~/stores/connection-store'
import { ActionMenu } from '~/components/ui/action-menu'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { RenamePrompt } from '~/components/ui/rename-prompt'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useChatSearchStore } from '~/stores/chat-search-store'
import { folderName } from '~/lib/folder-name'
import { useSessionModelLabel } from '~/hooks/useSessionModelLabel'
import { useChatModes } from '~/hooks/useChatModes'
import { ContextMeter } from './ContextMeter'

interface ChatHeaderProps {
  /** Current session — undefined while the chat is a draft (not sent yet). */
  session?: SessionInfo
  onRename: (title: string) => void
  onTogglePin: () => void
  onToggleArchive: () => void
  onFork: () => void
  onDelete: () => void
  /** Search in the conversation is exclusive to chat mode. */
  searchEnabled?: boolean
  /** Code mode: the row under the title opens with the folder and the branch. */
  code?: boolean
  /** Folders of the chat: the main one first, then the extra ones. */
  folders?: string[]
  /** Opens the folder & branch sheet — it belongs to the screen, so the "+" reaches it too. */
  onOpenWorkspace?: () => void
}

/** Stable identity for the default — the effect below compares the list by reference. */
const NO_FOLDERS: string[] = []

// memo: the header reads stores that change with the streaming (context meter) — without
// it the whole column would re-render on every delta flush.
export const ChatHeader = memo(function ChatHeader({
  session,
  onRename,
  onTogglePin,
  onToggleArchive,
  onFork,
  onDelete,
  searchEnabled,
  code,
  folders,
  onOpenWorkspace,
}: ChatHeaderProps) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const openSidebar = useWorkspaceStore((s) => s.openSidebar)
  const [menuOpen, setMenuOpen] = useState(false)
  const [branch, setBranch] = useState<string | null>(null)
  const folderList = folders ?? NO_FOLDERS
  const directory = folderList[0]
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const toggleChatSearch = useChatSearchStore((s) => s.toggle)

  const modelLabel = useSessionModelLabel(session?.id)
  const { activeModes } = useChatModes(session?.id)

  // G1 → G2: the conversation opens with the folder and its branch in the strip that is
  // the modes row; ~2.5 s later the same strip crossfades into modes + context (same
  // space, no reflow). Without a folder the picker stays above the input.
  const [intro, setIntro] = useState(true)
  const introOpacity = useRef(new Animated.Value(1)).current
  const modesOpacity = useRef(new Animated.Value(0)).current
  const introPlayedRef = useRef(false)
  const showFolderStrip = !!code && !!directory && intro
  const hasBottomRow = activeModes.length > 0 || showFolderStrip

  // Branch of the working folder: the strip shows it on open, and the menu item labels it.
  // Reads the folder selected in the screen (not session.directory), so switching folders
  // in the sheet already reflects the new branch, before the next send.
  const loadBranch = useCallback(async (isCancelled?: () => boolean) => {
    if (!directory) return
    try {
      const res = await useConnectionStore.getState().wsClient.send({ type: 'git:branches', directory })
      if (isCancelled?.()) return
      setBranch(res.ok && res.data ? (res.data as BranchesResponse).current || null : null)
    } catch {
      if (!isCancelled?.()) setBranch(null)
    }
  }, [directory])
  const [renaming, setRenaming] = useState(false)

  useEffect(() => {
    // One git call per opened chat, only in code mode — the strip needs the branch.
    // The answer can land after this header is gone (the app opens on the new chat and
    // replaces it with the last one), so the continuation checks that it is still alive.
    if (!code) return
    let alive = true
    void loadBranch(() => !alive)
    return () => {
      alive = false
    }
  }, [code, loadBranch])

  useEffect(() => {
    // Once per opened conversation: creating the session on the first send must not
    // replay the intro.
    if (!code || !directory || introPlayedRef.current) return
    introPlayedRef.current = true
    setIntro(true)
    introOpacity.setValue(1)
    modesOpacity.setValue(0)
    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(introOpacity, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(modesOpacity, { toValue: 1, duration: 260, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setIntro(false)
      })
    }, 2500)
    return () => clearTimeout(timer)
  }, [code, directory, introOpacity, modesOpacity])

  const handleDeletePress = async () => {
    const ok = await confirm({
      title: t('chatHeader.deleteTitle'),
      description: t('chatHeader.deleteBody', { title: session?.title }),
      confirmLabel: t('sidebar.delete'),
      cancelLabel: t('sidebar.cancel'),
      destructive: true,
    })
    if (ok) onDelete()
  }

  return (
    <View style={{ backgroundColor: tokens.background }}>
      <View
        style={[
          s.top,
          // The divider only exists when the row below has something to show.
          !hasBottomRow && { borderBottomWidth: 1, borderBottomColor: tokens.border },
        ]}
      >
        <Pressable onPress={openSidebar} style={s.iconButton}>
          <Menu size={22} color={tokens.foreground} />
        </Pressable>

        {/* Name of the chat and, below it, the model answering here — the persona is
            gone with the first message (it lives in the welcome screen). */}
        <View style={s.center}>
          <Text numberOfLines={1} style={[s.title, { color: tokens.foreground }]}>
            {session?.title ?? t('chatScreen.newConversationTitle')}
          </Text>
          <Text numberOfLines={1} style={[s.model, { color: tokens.mutedForeground }]}>
            {modelLabel}
          </Text>
        </View>

        {session ? (
          <Pressable onPress={() => { setMenuOpen(true); void loadBranch() }} style={s.iconButton}>
            <Ellipsis size={22} color={tokens.foreground} />
          </Pressable>
        ) : (
          <View style={s.iconButton} />
        )}
      </View>

      {/* Under the divider: on open, the folder and its branch; ~2.5 s later the modes
          that are on and the context. Both live in the same space, so nothing shifts. */}
      {hasBottomRow && (
        <View style={[s.modesRow, { borderTopWidth: 1, borderTopColor: tokens.border }]}>
          {showFolderStrip && (
            <Animated.View style={[s.layer, { opacity: introOpacity }]}>
              <Pressable onPress={onOpenWorkspace} style={s.folderStrip}>
                <Folder size={13} color={tokens.mutedForeground} />
                <Text numberOfLines={1} style={[s.folderName, { color: tokens.foreground }]}>
                  {directory ? folderName(directory) : ''}
                </Text>
                {folderList.length > 1 && (
                  <View style={s.folderCount}>
                    <View style={[s.folderDot, { backgroundColor: tokens.mutedForeground }]} />
                    <Text style={[s.folderCountText, { color: tokens.mutedForeground }]}>
                      {folderList.length - 1}
                    </Text>
                  </View>
                )}
                {branch ? (
                  <>
                    <Text style={[s.folderSep, { color: tokens.mutedForeground }]}>·</Text>
                    <Text numberOfLines={1} style={[s.folderBranch, { color: tokens.mutedForeground }]}>
                      {branch}
                    </Text>
                  </>
                ) : null}
                <ChevronDown size={11} color={tokens.mutedForeground} />
              </Pressable>
            </Animated.View>
          )}

          {activeModes.length > 0 && (
            <Animated.View style={[s.layer, { opacity: showFolderStrip ? modesOpacity : 1 }]}>
              <View style={s.modes}>
                {activeModes.map((mode) => (
                  <mode.icon key={mode.id} size={14} color={tokens.mutedForeground} />
                ))}
              </View>
              <View style={s.meterSlot}>
                <ContextMeter sessionId={session?.id} />
              </View>
            </Animated.View>
          )}
        </View>
      )}

      <ActionMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={[
          ...(searchEnabled ? [{ icon: Search, label: t('chatHeader.searchInChat'), onPress: toggleChatSearch }] : []),
          { icon: Pencil, label: t('sidebar.rename'), onPress: () => setRenaming(true) },
          {
            icon: session?.pinned ? PinOff : Pin,
            label: session?.pinned ? t('sidebar.unpin') : t('sidebar.pin'),
            onPress: onTogglePin,
          },
          {
            icon: session?.archived ? ArchiveRestore : Archive,
            label: session?.archived ? t('sidebar.unarchive') : t('sidebar.archive'),
            onPress: onToggleArchive,
          },
          ...(code
            ? [{ icon: GitBranch, label: t('workspace.menu'), onPress: () => onOpenWorkspace?.() }]
            : []),
          { icon: GitFork, label: t('chatHeader.fork'), onPress: onFork },
          { icon: Trash2, label: t('sidebar.delete'), destructive: true, onPress: handleDeletePress },
        ]}
      />

      <RenamePrompt
        visible={renaming}
        title={t('sidebar.renameConversation')}
        initialValue={session?.title ?? ''}
        onClose={() => setRenaming(false)}
        onSubmit={onRename}
      />
    </View>
  )
})

const s = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 4, paddingBottom: 2 },
  iconButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 1, paddingHorizontal: 4 },
  title: { fontSize: 15, fontWeight: '600' },
  model: { fontSize: 11.5 },
  modesRow: {
    position: 'relative',
    minHeight: 26,
    paddingTop: 4,
    paddingBottom: 5,
  },
  // Folder and modes are two layers of the same row: one fades out over the other.
  layer: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modes: { flexDirection: 'row', alignItems: 'center', gap: 14, opacity: 0.75 },
  meterSlot: { position: 'absolute', right: 16, top: 0, bottom: 0, justifyContent: 'center' },
  folderStrip: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' },
  folderName: { fontSize: 11.5, fontWeight: '600', maxWidth: 120 },
  folderCount: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  folderDot: { width: 3, height: 3, borderRadius: 1.5 },
  folderCountText: { fontSize: 11 },
  folderSep: { fontSize: 11.5 },
  folderBranch: { fontSize: 11, fontFamily: 'monospace', maxWidth: 140 },
})
