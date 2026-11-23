import { ScrollView, StyleSheet, Text } from 'react-native'
import { useTranslation } from 'react-i18next'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { useTokens } from '~/components/list/parts'
import { setSessionDirectory } from '~/lib/git-api'
import { WorktreeList } from './WorktreeList'

/**
 * The worktree picker of the project screen: the list in a bottom sheet. A switch points the chat's
 * session at the folder on the desktop (it refuses while the chat runs), so the files and the git of
 * this screen follow it at once.
 */
export function WorktreeSheet({
  open,
  folder,
  sessionId,
  suggestedName,
  onClose,
  onSwitched,
}: {
  open: boolean
  folder: string
  sessionId: string
  suggestedName?: string
  onClose: () => void
  /** The chat now works in this folder. */
  onSwitched: (folder: string) => void
}) {
  const { t } = useTranslation()
  const tokens = useTokens()
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={<Text style={[s.title, { color: tokens.foreground }]}>{t('project.worktree.title')}</Text>}
    >
      <ScrollView keyboardShouldPersistTaps="handled">
        <WorktreeList
          folder={folder}
          active={open}
          suggestedName={suggestedName}
          onSwitch={async (next) => {
            await setSessionDirectory(sessionId, next)
            onSwitched(next)
            onClose()
          }}
        />
      </ScrollView>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '600', paddingBottom: 8 },
})
