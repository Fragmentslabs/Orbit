import { memo, useState } from 'react'
import { View, Animated, Pressable, Alert, StyleSheet } from 'react-native'
import { Menu, Ellipsis, Pencil, Pin, PinOff, Archive, ArchiveRestore, GitFork, Trash2 } from 'lucide-react-native'
import type { SessionInfo } from '@orbit/shared'
import { Persona, type PersonaState } from '~/components/ai/Persona'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useAppearanceStore } from '~/stores/appearance-store'
import { ActionMenu } from '~/components/ui/action-menu'
import { RenamePrompt } from '~/components/ui/rename-prompt'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface ChatHeaderProps {
  /** Sessão atual — undefined enquanto o chat é um rascunho (ainda não enviado). */
  session?: SessionInfo
  personaState: PersonaState
  /** Opacidade animada do persona pequeno — só aparece depois da 1ª mensagem
   *  e só depois do persona grande do centro terminar de sumir. */
  personaOpacity: Animated.Value
  onRename: (title: string) => void
  onTogglePin: () => void
  onToggleArchive: () => void
  onFork: () => void
  onDelete: () => void
}

// memo: o header carrega a view nativa do Rive (Persona) — sem memo ele
// re-renderizava a cada flush de delta do streaming.
export const ChatHeader = memo(function ChatHeader({
  session,
  personaState,
  personaOpacity,
  onRename,
  onTogglePin,
  onToggleArchive,
  onFork,
  onDelete,
}: ChatHeaderProps) {
  const openSidebar = useWorkspaceStore((s) => s.openSidebar)
  const personaVisible = useAppearanceStore((s) => s.personaVisible)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const handleDeletePress = () => {
    Alert.alert(
      'Excluir conversa?',
      `"${session?.title}" e todas as suas mensagens serão excluídas permanentemente.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Excluir', style: 'destructive', onPress: onDelete },
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
        <Pressable onPress={() => setMenuOpen(true)} style={s.iconButton}>
          <Ellipsis size={22} color={tokens.foreground} />
        </Pressable>
      ) : (
        <View style={s.iconButton} />
      )}

      <ActionMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={[
          { icon: Pencil, label: 'Renomear', onPress: () => setRenaming(true) },
          {
            icon: session?.pinned ? PinOff : Pin,
            label: session?.pinned ? 'Desafixar' : 'Fixar',
            onPress: onTogglePin,
          },
          {
            icon: session?.archived ? ArchiveRestore : Archive,
            label: session?.archived ? 'Desarquivar' : 'Arquivar',
            onPress: onToggleArchive,
          },
          { icon: GitFork, label: 'Fork', onPress: onFork },
          { icon: Trash2, label: 'Excluir', destructive: true, onPress: handleDeletePress },
        ]}
      />

      <RenamePrompt
        visible={renaming}
        title="Renomear conversa"
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
