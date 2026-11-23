import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, CloudCheck, CloudOff } from 'lucide-react-native'
import type { GitCommit } from '@orbit/shared'
import { useTokens } from '~/components/list/parts'
import { gitCommitDiff, gitLog } from '~/lib/git-api'
import { shortAge, shortHash } from '~/lib/git-format'
import { DiffModal, type DiffTarget } from './DiffModal'

const STATUS_COLOR = { added: '#10b981', modified: '#f59e0b', deleted: '#ef4444', renamed: '#3b82f6' } as const
const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const

/**
 * The desktop's Commits tab: the log in pages of 30 (more as you reach the end), each commit with
 * its branches/tags, whether it is already on the remote, and the files it touched — a file opens
 * what that commit changed in it.
 */
export function CommitsTab({ directory, refreshKey }: { directory: string; refreshKey: number }) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const [commits, setCommits] = useState<GitCommit[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffTarget | null>(null)
  // An answer for a folder or a refresh that is no longer current never overwrites the list.
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const res = await gitLog(directory, 0)
      if (mine !== seq.current) return
      setCommits(res.commits)
      setHasMore(res.hasMore)
      setError(null)
    } catch (err) {
      if (mine === seq.current) setError((err as Error).message)
    }
  }, [directory])

  useEffect(() => {
    // Reads the repository when the folder is known and again whenever the screen bumps the key.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load, refreshKey])

  const more = async () => {
    if (!commits || !hasMore || loadingMore) return
    const mine = seq.current
    setLoadingMore(true)
    try {
      const res = await gitLog(directory, commits.length)
      if (mine !== seq.current) return
      setCommits((prev) => [...(prev ?? []), ...res.commits])
      setHasMore(res.hasMore)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoadingMore(false)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  if (!commits && !error) return <ActivityIndicator style={{ marginTop: 40 }} color={tokens.mutedForeground} />
  if (!commits) return <Text style={[s.empty, { color: tokens.destructive }]}>{error}</Text>

  return (
    <>
      <FlatList
        data={commits}
        keyExtractor={(c) => c.hash}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        onEndReached={() => void more()}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={<Text style={[s.empty, { color: tokens.mutedForeground }]}>{t('project.commits.empty')}</Text>}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ margin: 16 }} color={tokens.mutedForeground} /> : null}
        renderItem={({ item }) => {
          const expanded = open === item.hash
          const Chevron = expanded ? ChevronDown : ChevronRight
          return (
            <View style={[s.item, { borderBottomColor: tokens.border }]}>
              <Pressable
                onPress={() => setOpen(expanded ? null : item.hash)}
                style={({ pressed }) => [s.head, pressed && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
              >
                <Chevron size={16} color={tokens.mutedForeground} style={{ marginTop: 2 }} />
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <Text numberOfLines={expanded ? undefined : 2} style={[s.message, { color: tokens.foreground }]}>{item.message}</Text>
                  {item.refs.length > 0 ? (
                    <View style={s.refs}>
                      {item.refs.map((ref) => (
                        <View key={ref} style={[s.ref, { borderColor: tokens.border, backgroundColor: tokens.muted }]}>
                          <Text numberOfLines={1} style={[s.refText, { color: tokens.mutedForeground }]}>{ref}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                  <Text numberOfLines={1} style={[s.meta, { color: tokens.mutedForeground }]}>
                    {shortHash(item.hash)} · {item.author} · {shortAge(item.date)}
                  </Text>
                </View>
                {item.pushed ? (
                  <CloudCheck size={15} color="#10b981" accessibilityLabel={t('project.commits.pushed')} />
                ) : (
                  <CloudOff size={15} color={tokens.mutedForeground} accessibilityLabel={t('project.commits.local')} />
                )}
              </Pressable>
              {expanded ? (
                <View style={{ paddingLeft: 40, paddingRight: 16, paddingBottom: 10, gap: 2 }}>
                  {item.body ? <Text style={[s.body, { color: tokens.mutedForeground }]}>{item.body}</Text> : null}
                  {item.files.map((file) => (
                    <Pressable
                      key={`${file.status}:${file.path}`}
                      onPress={() =>
                        setDiff({
                          title: file.path.split('/').pop() ?? file.path,
                          subtitle: `${shortHash(item.hash)} · ${file.path}`,
                          load: () => gitCommitDiff(directory, item.hash, file.path),
                        })
                      }
                      style={({ pressed }) => [s.file, pressed && { opacity: 0.6 }]}
                      accessibilityRole="button"
                    >
                      <Text style={[s.letter, { color: STATUS_COLOR[file.status] }]}>{STATUS_LETTER[file.status]}</Text>
                      <Text numberOfLines={1} style={[s.filePath, { color: tokens.foreground }]}>{file.path}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          )
        }}
      />
      <DiffModal target={diff} onClose={() => setDiff(null)} />
    </>
  )
}

const s = StyleSheet.create({
  empty: { fontSize: 13, textAlign: 'center', padding: 28 },
  item: { borderBottomWidth: StyleSheet.hairlineWidth },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
  message: { fontSize: 14.5, fontWeight: '500', lineHeight: 20 },
  refs: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  ref: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, maxWidth: 180 },
  refText: { fontSize: 10.5, fontFamily: 'monospace' },
  meta: { fontSize: 11.5 },
  body: { fontSize: 12.5, lineHeight: 18, paddingBottom: 6 },
  file: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7 },
  letter: { width: 14, fontSize: 11.5, fontWeight: '700', textAlign: 'center', fontFamily: 'monospace' },
  filePath: { flex: 1, fontSize: 12.5, fontFamily: 'monospace' },
})
