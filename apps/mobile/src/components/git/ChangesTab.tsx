import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Keyboard, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FileDiff, GitCommitHorizontal } from 'lucide-react-native'
import type { GitChangedFile, GitChangeStatus } from '@orbit/shared'
import { useTokens } from '~/components/list/parts'
import { gitCommit, gitDiff, gitStatus } from '~/lib/git-api'
import { DiffModal, type DiffTarget } from './DiffModal'

const STATUS_COLOR: Record<GitChangeStatus, string> = {
  added: '#10b981',
  untracked: '#10b981',
  modified: '#f59e0b',
  deleted: '#ef4444',
  renamed: '#3b82f6',
}
const STATUS_LETTER: Record<GitChangeStatus, string> = { added: 'A', untracked: 'U', modified: 'M', deleted: 'D', renamed: 'R' }

/**
 * The desktop's Changes tab: the files changed against HEAD with their +/- counts, a commit box
 * on top (it commits everything, like the desktop) and a diff for each file or for all of them.
 */
export function ChangesTab({
  directory,
  refreshKey,
  onChanged,
}: {
  directory: string
  /** Bumped by the screen after a pull or a switch, to read the tree again. */
  refreshKey: number
  /** A commit changed the tree and the log: the screen refreshes its bar and the other tabs. */
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const [files, setFiles] = useState<GitChangedFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffTarget | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await gitStatus(directory)
      setFiles(res.files)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [directory])

  useEffect(() => {
    // Reads the repository when the folder is known and again whenever the screen bumps the key.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load, refreshKey])

  const refresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const commit = async () => {
    const text = message.trim()
    if (!text || committing) return
    Keyboard.dismiss()
    setCommitting(true)
    setCommitError(null)
    try {
      await gitCommit(directory, text)
      setMessage('')
      await load()
      onChanged()
    } catch (err) {
      setCommitError((err as Error).message || t('project.commit.failed'))
    } finally {
      setCommitting(false)
    }
  }

  const totals = (files ?? []).reduce((acc, f) => ({ a: acc.a + (f.added ?? 0), d: acc.d + (f.deleted ?? 0) }), { a: 0, d: 0 })
  const canCommit = !!message.trim() && (files?.length ?? 0) > 0 && !committing

  if (!files && !error) return <ActivityIndicator style={{ marginTop: 40 }} color={tokens.mutedForeground} />
  if (!files) return <Text style={[s.empty, { color: tokens.destructive }]}>{error}</Text>

  return (
    <>
      <FlatList
        data={files}
        keyExtractor={(f) => f.path}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        ListHeaderComponent={
          files.length > 0 ? (
            <View>
              <View style={[s.commitBox, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
                <TextInput
                  value={message}
                  onChangeText={setMessage}
                  placeholder={t('project.commit.placeholder')}
                  placeholderTextColor={tokens.mutedForeground}
                  multiline
                  style={[s.commitInput, { color: tokens.foreground }]}
                />
                <Pressable
                  onPress={() => void commit()}
                  disabled={!canCommit}
                  accessibilityRole="button"
                  style={[s.commitBtn, { backgroundColor: tokens.primary, opacity: canCommit ? 1 : 0.4 }]}
                >
                  {committing ? (
                    <ActivityIndicator size="small" color={tokens.primaryForeground} />
                  ) : (
                    <GitCommitHorizontal size={16} color={tokens.primaryForeground} />
                  )}
                  <Text style={{ color: tokens.primaryForeground, fontWeight: '600', fontSize: 13 }}>
                    {t('project.commit.button', { count: files.length })}
                  </Text>
                </Pressable>
              </View>
              {commitError ? <Text style={[s.commitError, { color: tokens.destructive }]}>{commitError}</Text> : null}
              <Pressable
                onPress={() =>
                  setDiff({
                    title: t('changes.title'),
                    subtitle: t('changes.allChanges', { count: files.length }),
                    collapsible: true,
                    load: () => gitDiff(directory),
                  })
                }
                style={[s.allRow, { borderBottomColor: tokens.border }]}
                accessibilityRole="button"
              >
                <FileDiff size={16} color={tokens.foreground} />
                <Text style={[s.rowName, { color: tokens.foreground, flex: 1 }]}>{t('changes.allChanges', { count: files.length })}</Text>
                <Counts added={totals.a} deleted={totals.d} destructive={tokens.destructive} />
                <ChevronRight size={16} color={tokens.mutedForeground} />
              </Pressable>
            </View>
          ) : null
        }
        ListEmptyComponent={<Text style={[s.empty, { color: tokens.mutedForeground }]}>{t('changes.empty')}</Text>}
        renderItem={({ item }) => {
          const name = item.path.split('/').pop() ?? item.path
          const dir = item.path.slice(0, item.path.length - name.length).replace(/\/$/, '')
          return (
            <Pressable
              onPress={() =>
                setDiff({ title: name, subtitle: item.path, load: () => gitDiff(directory, item.path) })
              }
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
      <DiffModal target={diff} onClose={() => setDiff(null)} />
    </>
  )
}

export function Counts({ added, deleted, destructive }: { added?: number; deleted?: number; destructive: string }) {
  if (added === undefined && deleted === undefined) return null
  return (
    <Text style={s.counts}>
      {added ? <Text style={{ color: '#10b981' }}>+{added} </Text> : null}
      {deleted ? <Text style={{ color: destructive }}>-{deleted}</Text> : null}
    </Text>
  )
}

const s = StyleSheet.create({
  empty: { fontSize: 13, textAlign: 'center', padding: 28 },
  commitBox: { margin: 12, borderWidth: 1, borderRadius: 14, padding: 10, gap: 8 },
  commitInput: { minHeight: 44, maxHeight: 120, fontSize: 14.5, paddingHorizontal: 4, paddingTop: 4, textAlignVertical: 'top' },
  commitBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 10, height: 40 },
  commitError: { fontSize: 12.5, paddingHorizontal: 16, paddingBottom: 8 },
  allRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: 1 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  letter: { width: 16, fontSize: 12, fontWeight: '700', textAlign: 'center', fontFamily: 'monospace' },
  rowName: { fontSize: 14, fontWeight: '500' },
  sub: { fontSize: 11.5 },
  counts: { fontSize: 12, fontWeight: '600' },
})
