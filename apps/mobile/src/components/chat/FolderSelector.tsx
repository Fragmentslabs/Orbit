import { useCallback, useEffect, useState } from 'react'
import { Modal, View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Folder, FolderUp, Plus, X, Check, History, Layers, ChevronDown } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { ListDirsResponse } from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'
import { Storage } from '~/lib/storage'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const RECENT_FOLDERS_KEY = 'orbit_recent_folders'
const MAX_RECENT = 6

function folderName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

async function loadRecentFolders(): Promise<string[]> {
  try {
    const raw = await Storage.getItem(RECENT_FOLDERS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

async function saveRecentFolder(path: string): Promise<void> {
  const current = await loadRecentFolders()
  const next = [path, ...current.filter((p) => p !== path)].slice(0, MAX_RECENT)
  await Storage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(next))
}

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

      {/* Com pasta extra, as chips + o "+" quebravam a linha e o X de uma chip
          encostava no "+" da seguinte. Vira um botao so, que abre a lista —
          mesma saida do desktop em tela estreita (CompactWorkspaceSelector). */}
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
 * Pastas extras da sessao. Existe para o seletor caber numa linha so: com
 * duas ou mais, as chips quebravam e o X de remover encostava no "+".
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

function DirBrowserModal({
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
  const wsClient = useConnectionStore((s) => s.wsClient)
  const [listing, setListing] = useState<ListDirsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState<string[]>([])

  const browse = useCallback(
    async (path?: string) => {
      setLoading(true)
      setError(null)
      try {
        const res = await wsClient.send({ type: 'fs:list-dirs', path })
        if (res.ok && res.data) {
          setListing(res.data as ListDirsResponse)
        } else {
          setError(res.error ?? t('folderSelector.listError'))
        }
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    },
    [wsClient],
  )

  useEffect(() => {
    if (visible) {
      void browse()
      void loadRecentFolders().then(setRecent)
    }
  }, [visible, browse])

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

          {recent.length > 0 && (
            <View style={s.recentsRow}>
              <History size={12} color={tokens.mutedForeground} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                {recent.map((path) => (
                  <Pressable key={path} onPress={() => onPick(path)} style={[s.recentChip, { borderColor: tokens.muted, backgroundColor: tokens.border }]}>
                    <Folder size={11} color={tokens.mutedForeground} />
                    <Text style={[s.recentChipText, { color: tokens.foreground }]} numberOfLines={1}>{folderName(path)}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}

          <View style={[s.currentRow, { backgroundColor: tokens.border }]}>
            <Text style={[s.currentPath, { color: tokens.mutedForeground }]} numberOfLines={1}>
              {listing?.path ?? '…'}
            </Text>
            <Pressable
              onPress={() => listing && onPick(listing.path)}
              disabled={!listing}
              style={[s.useBtn, { backgroundColor: tokens.primary }]}
            >
              <Check size={14} color={tokens.primaryForeground} />
              <Text style={[s.useBtnText, { color: tokens.primaryForeground }]}>{t('folderSelector.useThis')}</Text>
            </Pressable>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }}>
            {listing?.parent && (
              <Pressable onPress={() => void browse(listing.parent!)} style={s.dirRow}>
                <FolderUp size={16} color={tokens.mutedForeground} />
                <Text style={[s.dirName, { color: tokens.foreground }]}>..</Text>
              </Pressable>
            )}
            {loading ? (
              <View style={{ paddingVertical: 32, alignItems: 'center' }}>
                <ActivityIndicator color={tokens.primary} />
              </View>
            ) : error ? (
              <Text style={[s.errorText, { color: tokens.destructive }]}>{error}</Text>
            ) : (
              listing?.dirs.map((dir) => (
                <Pressable key={dir.path} onPress={() => void browse(dir.path)} style={s.dirRow}>
                  <Folder size={16} color={tokens.mutedForeground} />
                  <Text style={[s.dirName, { color: tokens.foreground }]} numberOfLines={1}>{dir.name}</Text>
                </Pressable>
              ))
            )}
            {!loading && !error && listing?.dirs.length === 0 && (
              <Text style={[s.emptyText, { color: tokens.mutedForeground }]}>{t('folderSelector.noSubfolders')}</Text>
            )}
          </ScrollView>
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
  },
  chipText: { fontSize: 13, fontWeight: '500' },
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

  recentsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  recentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 9999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: 140,
  },
  recentChipText: { fontSize: 12 },

  currentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
  },
  currentPath: { flex: 1, fontSize: 12, fontFamily: 'monospace' },
  useBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  useBtnText: { fontSize: 12, fontWeight: '600' },

  dirRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 11, borderRadius: 10 },
  dirName: { flex: 1, fontSize: 14 },
  errorText: { padding: 16, fontSize: 13 },
  emptyText: { padding: 16, fontSize: 13 },
})
