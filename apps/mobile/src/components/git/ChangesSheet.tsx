import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FileDiff, RefreshCw, X } from 'lucide-react-native'
import type { GitChangedFile, GitChangeStatus } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { gitDiff, gitStatus } from '~/lib/git-api'
import { useThemeStore } from '~/stores/theme-store'
import { DiffView } from './DiffView'

const STATUS_COLOR: Record<GitChangeStatus, string> = {
  added: '#10b981',
  untracked: '#10b981',
  modified: '#f59e0b',
  deleted: '#ef4444',
  renamed: '#3b82f6',
}
const STATUS_LETTER: Record<GitChangeStatus, string> = { added: 'A', untracked: 'U', modified: 'M', deleted: 'D', renamed: 'R' }

type View_ = { kind: 'list' } | { kind: 'file'; file: GitChangedFile } | { kind: 'all' }

/**
 * Changes of the session folder, like the desktop's Changes view: the list of changed files
 * with their +/- counts; tapping one opens its diff, "All changes" stacks every file.
 */
export function ChangesSheet({ visible, directory, onClose }: { visible: boolean; directory?: string; onClose: () => void }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((st) => st.resolved))
  const insets = useSafeAreaInsets()
  const [view, setView] = useState<View_>({ kind: 'list' })
  const [files, setFiles] = useState<GitChangedFile[] | null>(null)
  const [branch, setBranch] = useState('')
  const [patch, setPatch] = useState<{ text: string; truncated: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadList = useCallback(async () => {
    if (!directory) return
    setLoading(true)
    setError(null)
    try {
      const res = await gitStatus(directory)
      setFiles(res.files)
      setBranch(res.branch)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [directory])

  const openDiff = useCallback(
    async (next: View_) => {
      if (!directory) return
      setView(next)
      setPatch(null)
      setLoading(true)
      setError(null)
      try {
        const res = await gitDiff(directory, next.kind === 'file' ? next.file.path : undefined)
        setPatch({ text: res.patch, truncated: !!res.truncated })
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [directory],
  )

  useEffect(() => {
    if (!visible) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView({ kind: 'list' })
    void loadList()
  }, [visible, loadList])

  const back = () => {
    setView({ kind: 'list' })
    setError(null)
  }
  const title = view.kind === 'file' ? view.file.path.split('/').pop() : t('changes.title')
  const totals = (files ?? []).reduce((acc, f) => ({ a: acc.a + (f.added ?? 0), d: acc.d + (f.deleted ?? 0) }), { a: 0, d: 0 })

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={view.kind === 'list' ? onClose : back}>
      <View style={[s.root, { backgroundColor: tokens.background, paddingTop: 8 }]}>
        <View style={[s.header, { borderBottomColor: tokens.border }]}>
          <Pressable onPress={view.kind === 'list' ? onClose : back} hitSlop={8} style={s.iconBtn} accessibilityRole="button">
            {view.kind === 'list' ? <X size={20} color={tokens.foreground} /> : <ChevronRight size={20} color={tokens.foreground} style={{ transform: [{ rotate: '180deg' }] }} />}
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={[s.title, { color: tokens.foreground }]}>{title}</Text>
            {view.kind === 'list' && branch ? (
              <Text numberOfLines={1} style={[s.sub, { color: tokens.mutedForeground }]}>{branch}</Text>
            ) : view.kind === 'file' ? (
              <Text numberOfLines={1} style={[s.sub, { color: tokens.mutedForeground }]}>{view.file.path}</Text>
            ) : null}
          </View>
          <Pressable
            onPress={() => (view.kind === 'list' ? void loadList() : void openDiff(view))}
            hitSlop={8}
            style={s.iconBtn}
            accessibilityRole="button"
            accessibilityLabel={t('changes.refresh')}
          >
            <RefreshCw size={18} color={tokens.mutedForeground} />
          </Pressable>
        </View>

        {loading && !(view.kind === 'list' && files) ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={tokens.mutedForeground} />
        ) : error ? (
          <Text style={[s.empty, { color: tokens.destructive }]}>{error}</Text>
        ) : view.kind === 'list' ? (
          <FlatList
            data={files ?? []}
            keyExtractor={(f) => f.path}
            contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
            ListHeaderComponent={
              files && files.length > 0 ? (
                <Pressable
                  onPress={() => void openDiff({ kind: 'all' })}
                  style={[s.allRow, { borderBottomColor: tokens.border }]}
                  accessibilityRole="button"
                >
                  <FileDiff size={16} color={tokens.foreground} />
                  <Text style={[s.rowName, { color: tokens.foreground, flex: 1 }]}>
                    {t('changes.allChanges', { count: files.length })}
                  </Text>
                  <Counts added={totals.a} deleted={totals.d} destructive={tokens.destructive} />
                  <ChevronRight size={16} color={tokens.mutedForeground} />
                </Pressable>
              ) : null
            }
            ListEmptyComponent={<Text style={[s.empty, { color: tokens.mutedForeground }]}>{t('changes.empty')}</Text>}
            renderItem={({ item }) => {
              const name = item.path.split('/').pop() ?? item.path
              const dir = item.path.slice(0, item.path.length - name.length).replace(/\/$/, '')
              return (
                <Pressable
                  onPress={() => void openDiff({ kind: 'file', file: item })}
                  style={({ pressed }) => [s.fileRow, { borderBottomColor: tokens.border }, pressed && { opacity: 0.6 }]}
                  accessibilityRole="button"
                >
                  <Text style={[s.letter, { color: STATUS_COLOR[item.status] }]}>{STATUS_LETTER[item.status]}</Text>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={[s.rowName, { color: item.status === 'deleted' ? tokens.mutedForeground : tokens.foreground }]}>{name}</Text>
                    {dir ? <Text numberOfLines={1} style={[s.sub, { color: tokens.mutedForeground }]}>{dir}</Text> : null}
                  </View>
                  <Counts added={item.added} deleted={item.deleted} destructive={tokens.destructive} />
                  <ChevronRight size={16} color={tokens.mutedForeground} />
                </Pressable>
              )
            }}
          />
        ) : patch ? (
          <DiffView
            patch={patch.text}
            collapsible={view.kind === 'all'}
            footer={patch.truncated ? <Text style={[s.empty, { color: tokens.mutedForeground }]}>{t('changes.truncated')}</Text> : undefined}
          />
        ) : null}
      </View>
    </Modal>
  )
}

function Counts({ added, deleted, destructive }: { added?: number; deleted?: number; destructive: string }) {
  if (added === undefined && deleted === undefined) return null
  return (
    <Text style={s.counts}>
      {added ? <Text style={{ color: '#10b981' }}>+{added} </Text> : null}
      {deleted ? <Text style={{ color: destructive }}>-{deleted}</Text> : null}
    </Text>
  )
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingBottom: 8, borderBottomWidth: 1 },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 16, fontWeight: '600' },
  sub: { fontSize: 11.5 },
  empty: { fontSize: 13, textAlign: 'center', padding: 28 },
  allRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: 1 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  letter: { width: 16, fontSize: 12, fontWeight: '700', textAlign: 'center', fontFamily: 'monospace' },
  rowName: { fontSize: 14, fontWeight: '500' },
  counts: { fontSize: 12, fontWeight: '600' },
})
