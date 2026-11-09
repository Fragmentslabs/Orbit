import { useCallback, useState } from 'react'
import { Modal, View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Folder, Plus, X, Layers, ChevronDown } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { folderName } from '~/lib/folder-name'
import { saveRecentFolder } from '~/lib/folder-recents'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { DirBrowserBody } from './DirBrowserBody'

interface FolderSelectorProps {
  folders: string[]
  onFoldersChange: (folders: string[]) => void
  disabled?: boolean
}

export function FolderSelector({ folders, onFoldersChange, disabled }: FolderSelectorProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserTarget, setBrowserTarget] = useState<'primary' | 'extra'>('primary')
  const [extrasOpen, setExtrasOpen] = useState(false)
  const extras = folders.slice(1)

  const openBrowser = (target: 'primary' | 'extra') => {
    if (disabled) return
    setBrowserTarget(target)
    setBrowserOpen(true)
  }

  const handlePicked = useCallback(
    (path: string) => {
      setBrowserOpen(false)
      void saveRecentFolder(path)
      if (browserTarget === 'primary') {
        if (folders[0] === path) return
        onFoldersChange([path, ...folders.slice(1).filter((f) => f !== path)])
      } else {
        if (folders.includes(path)) return
        onFoldersChange([...folders, path])
      }
    },
    [browserTarget, folders, onFoldersChange],
  )

  const removeFolder = (path: string) => {
    if (disabled) return
    onFoldersChange(folders.filter((f) => f !== path))
  }

  return (
    <View style={s.row}>
      <Pressable onPress={() => openBrowser('primary')} style={[s.chip, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
        <Folder size={13} color={tokens.primary} />
        <Text style={[s.chipText, { color: tokens.foreground }]} numberOfLines={1}>
          {folders.length === 0 ? t('folderSelector.associateFolder') : folderName(folders[0])}
        </Text>
      </Pressable>

      {/* With an extra folder, the chips + the "+" wrapped the line and the X of one chip
          touched the "+" of the next one. It becomes a single button, which opens the list —
          the same way out as the desktop on a narrow screen (CompactWorkspaceSelector). */}
      {extras.length > 0 ? (
        <Pressable
          onPress={() => setExtrasOpen(true)}
          style={[s.chip, { borderColor: tokens.border, backgroundColor: tokens.card }]}
        >
          <Layers size={13} color={tokens.mutedForeground} />
          <Text style={[s.chipText, { color: tokens.foreground }]} numberOfLines={1}>
            {t('folderSelector.extraCount', { count: extras.length })}
          </Text>
          <ChevronDown size={12} color={tokens.mutedForeground} />
        </Pressable>
      ) : (
        folders.length > 0 && !disabled && (
          <Pressable onPress={() => openBrowser('extra')} style={[s.addBtn, { borderColor: tokens.border }]}>
            <Plus size={14} color={tokens.mutedForeground} />
          </Pressable>
        )
      )}

      <DirBrowserModal visible={browserOpen} onClose={() => setBrowserOpen(false)} onPick={handlePicked} />
      <ExtraFoldersSheet
        visible={extrasOpen}
        folders={extras}
        disabled={disabled}
        onClose={() => setExtrasOpen(false)}
        onRemove={removeFolder}
        onAdd={() => {
          setExtrasOpen(false)
          openBrowser('extra')
        }}
      />
    </View>
  )
}

/**
 * Extra folders of the session. It exists so the selector fits on a single line: with
 * two or more, the chips wrapped and the remove X touched the "+".
 */
function ExtraFoldersSheet({
  visible,
  folders,
  disabled,
  onClose,
  onRemove,
  onAdd,
}: {
  visible: boolean
  folders: string[]
  disabled?: boolean
  onClose: () => void
  onRemove: (path: string) => void
  onAdd: () => void
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdropWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[s.extrasSheet, { paddingBottom: insets.bottom + 12, backgroundColor: tokens.background, borderColor: tokens.border }]}>
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />
          <View style={s.sheetHeader}>
            <Text style={[s.sheetTitle, { color: tokens.foreground }]}>{t('folderSelector.extraTitle')}</Text>
            <Pressable onPress={onClose} style={{ padding: 4 }}>
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>

          <ScrollView style={{ maxHeight: 280 }}>
            {folders.map((folder) => (
              <View key={folder} style={s.extraRow}>
                <Folder size={16} color={tokens.mutedForeground} />
                <Text style={[s.extraName, { color: tokens.foreground }]} numberOfLines={1}>
                  {folderName(folder)}
                </Text>
                {!disabled && (
                  <Pressable onPress={() => onRemove(folder)} hitSlop={10} style={{ padding: 4 }}>
                    <X size={16} color={tokens.mutedForeground} />
                  </Pressable>
                )}
              </View>
            ))}
          </ScrollView>

          {!disabled && (
            <Pressable onPress={onAdd} style={[s.extraAddRow, { borderColor: tokens.border }]}>
              <Plus size={16} color={tokens.primary} />
              <Text style={[s.extraName, { color: tokens.foreground }]}>{t('folderSelector.addFolder')}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  )
}

export function DirBrowserModal({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean
  onClose: () => void
  onPick: (path: string) => void
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdropWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <View style={[s.sheet, { paddingBottom: insets.bottom + 12, backgroundColor: tokens.background, borderColor: tokens.border }]}>
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />

          <View style={s.sheetHeader}>
            <Text style={[s.sheetTitle, { color: tokens.foreground }]}>{t('folderSelector.selectFolderTitle')}</Text>
            <Pressable onPress={onClose} style={{ padding: 4 }}>
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>

          <DirBrowserBody active={visible} onPick={onPick} />
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
    maxWidth: 160,
    flexShrink: 1,
    minWidth: 0,
  },
  chipText: { fontSize: 13, fontWeight: '500', flexShrink: 1, flex: 1, minWidth: 0 },
  addBtn: {
    width: 30,
    height: 30,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  extrasSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  extraRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 11, borderRadius: 10 },
  extraName: { flex: 1, fontSize: 14 },
  extraAddRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
  },

  backdropWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    height: '78%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 12 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sheetTitle: { fontSize: 16, fontWeight: '600' },

})
