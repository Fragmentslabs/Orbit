import { memo, useCallback, useState } from 'react'
import { View, Animated, Pressable, Alert, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Menu, Ellipsis, Pencil, Pin, PinOff, Archive, ArchiveRestore, GitFork, GitBranch, Search, Trash2 } from 'lucide-react-native'
import { showsPersonaInChat, type SessionInfo, type BranchesResponse } from '@orbit/shared'
import { Persona, type PersonaState } from '~/components/ai/Persona'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useConnectionStore } from '~/stores/connection-store'
import { useAppearanceStore } from '~/stores/appearance-store'
import { ActionMenu } from '~/components/ui/action-menu'
import { RenamePrompt } from '~/components/ui/rename-prompt'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useChatSearchStore } from '~/stores/chat-search-store'
import { BranchSheet } from '~/components/chat/BranchSheet'

interface ChatHeaderProps {
  /** Current session — undefined while the chat is a draft (not sent yet). */
  session?: SessionInfo
  personaState: PersonaState
  /** Animated opacity of the small persona — it only shows up after the 1st message
   *  and only after the large persona in the center finishes fading out. */
  personaOpacity: Animated.Value
  onRename: (title: string) => void
  onTogglePin: () => void
  onToggleArchive: () => void
  onFork: () => void
  onDelete: () => void
  /** Search in the conversation is exclusive to chat mode. */
  searchEnabled?: boolean
}

// memo: the header carries the native Rive view (Persona) — without memo it
// re-rendered on every delta flush of the streaming.
export const ChatHeader = memo(function ChatHeader({
  session,
  personaState,
  personaOpacity,
  onRename,
  onTogglePin,
  onToggleArchive,
  onFork,
  onDelete,
  searchEnabled,
}: ChatHeaderProps) {
  const { t } = useTranslation()
  const openSidebar = useWorkspaceStore((s) => s.openSidebar)
  // Only the persona at the top: the one of the greeting is another choice (see PersonaVisibility).
  const personaVisible = showsPersonaInChat(useAppearanceStore((s) => s.personaVisibility))
  const [menuOpen, setMenuOpen] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [branch, setBranch] = useState<string | null>(null)

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
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const toggleChatSearch = useChatSearchStore((s) => s.toggle)

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
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: personaVisible ? 8 : 2, borderBottomWidth: 1, borderBottomColor: tokens.border, backgroundColor: tokens.background }}>
      <Pressable onPress={openSidebar} style={s.iconButton}>
        <Menu size={22} color={tokens.foreground} />
      </Pressable>

      {personaVisible && (
        <View style={s.center}>
          <Animated.View style={{ opacity: personaOpacity }}>
            <Persona state={personaState} size={36} />
          </Animated.View>
        </View>
      )}

      {session ? (
        <Pressable onPress={() => { setMenuOpen(true); void loadBranch() }} style={s.iconButton}>
          <Ellipsis size={22} color={tokens.foreground} />
        </Pressable>
      ) : (
        <View style={s.iconButton} />
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
  iconButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
})
