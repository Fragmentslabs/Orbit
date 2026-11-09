import { memo, useCallback, useState } from 'react'
import { View, Pressable, Alert, StyleSheet, Text } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Menu, Ellipsis, Pencil, Pin, PinOff, Archive, ArchiveRestore, GitFork, GitBranch, Search, Trash2 } from 'lucide-react-native'
import type { SessionInfo, BranchesResponse } from '@orbit/shared'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useConnectionStore } from '~/stores/connection-store'
import { ActionMenu } from '~/components/ui/action-menu'
import { RenamePrompt } from '~/components/ui/rename-prompt'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useChatSearchStore } from '~/stores/chat-search-store'
import { BranchSheet } from '~/components/chat/BranchSheet'
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
}

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
}: ChatHeaderProps) {
  const { t } = useTranslation()
  const openSidebar = useWorkspaceStore((s) => s.openSidebar)
  const [menuOpen, setMenuOpen] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [branch, setBranch] = useState<string | null>(null)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const toggleChatSearch = useChatSearchStore((s) => s.toggle)

  const modelLabel = useSessionModelLabel(session?.id)
  const { activeModes } = useChatModes(session?.id)

  // Current branch of the working folder, only to label the menu item. Fetched
  // when opening the menu (and not on mount) so as not to run git on every chat shown.
  const loadBranch = useCallback(async () => {
    if (!session?.directory) return
    const res = await useConnectionStore
      .getState()
      .wsClient.send({ type: 'git:branches', directory: session.directory })
    if (res.ok && res.data) setBranch((res.data as BranchesResponse).current || null)
  }, [session?.directory])
  const [renaming, setRenaming] = useState(false)

  const handleDeletePress = () => {
    Alert.alert(
      t('chatHeader.deleteTitle'),
      t('chatHeader.deleteBody', { title: session?.title }),
      [
        { text: t('sidebar.cancel'), style: 'cancel' },
        { text: t('sidebar.delete'), style: 'destructive', onPress: onDelete },
      ],
    )
  }

  return (
    <View style={{ backgroundColor: tokens.background }}>
      <View
        style={[
          s.top,
          // With no mode on the divider falls back to the bottom of the title row.
          activeModes.length === 0 && { borderBottomWidth: 1, borderBottomColor: tokens.border },
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

      {/* The modes that are on, centred in grey under the divider, with the context of
          the conversation pinned at the right so it does not throw the centre off. */}
      {activeModes.length > 0 && (
        <View style={[s.modesRow, { borderTopWidth: 1, borderTopColor: tokens.border }]}>
          <View style={s.modes}>
            {activeModes.map((mode) => (
              <mode.icon key={mode.id} size={14} color={tokens.mutedForeground} />
            ))}
          </View>
          <View style={s.meterSlot}>
            <ContextMeter sessionId={session?.id} />
          </View>
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
          ...(session?.directory
            ? [{
                icon: GitBranch,
                label: branch ? t('branch.menuWith', { branch }) : t('branch.menu'),
                onPress: () => setBranchOpen(true),
              }]
            : []),
          { icon: GitFork, label: t('chatHeader.fork'), onPress: onFork },
          { icon: Trash2, label: t('sidebar.delete'), destructive: true, onPress: handleDeletePress },
        ]}
      />

      <BranchSheet
        visible={branchOpen}
        directory={session?.directory}
        onClose={() => { setBranchOpen(false); void loadBranch() }}
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 26,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 5,
  },
  modes: { flexDirection: 'row', alignItems: 'center', gap: 14, opacity: 0.75 },
  meterSlot: { position: 'absolute', right: 16, top: 0, bottom: 0, justifyContent: 'center' },
})
