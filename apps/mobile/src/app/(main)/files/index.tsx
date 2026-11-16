import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FolderTree } from 'lucide-react-native'
import type { FileDirEntry, FilesListResponse } from '@orbit/shared'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { ListHeader, SearchField, useTokens } from '~/components/list/parts'
import { FileIcon } from '~/components/files/FileIcon'
import { filesApi } from '~/lib/files-api'
import { baseName, breadcrumbs, formatBytes, parentPath } from '~/lib/files'

interface Row {
  key: string
  name: string
  path: string
  dir: string
  isDirectory: boolean
  size?: number
}

/**
 * Files of a chat's working folder: a tree you walk one folder at a time (each folder is a
 * screen, so the native back gesture goes up a level), a breadcrumb to jump to any
 * ancestor, and a by-name search over the whole project. The desktop does the listing and
 * keeps every path inside the session's folders.
 */
export default function FilesScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = useTokens()
  const params = useLocalSearchParams<{ sessionId: string; root?: string; path?: string }>()
  const sessionId = params.sessionId
  const path = params.path ?? ''

  const [rootOverride, setRootOverride] = useState<string | undefined>(params.root || undefined)
  const [listing, setListing] = useState<FilesListResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [hitsRaw, setHits] = useState<Row[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const searchSeq = useRef(0)

  // An emptied field drops the results without an effect-driven state reset.
  const hits = query.trim() ? hitsRaw : null

  const scope = useMemo(() => ({ sessionId, root: rootOverride }), [sessionId, rootOverride])

  const [reload, setReload] = useState(0)
  const load = () => setReload((n) => n + 1)

  useEffect(() => {
    let alive = true
    filesApi
      .list(scope, path)
      .then((res) => {
        if (!alive) return
        setListing(res)
        setError(null)
      })
      .catch((err: Error) => alive && setError(err.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [scope, path, reload])

  // Debounced name search across the whole project; an older answer never overwrites a newer one.
  useEffect(() => {
    const q = query.trim()
    if (!q) return
    const seq = ++searchSeq.current
    const timer = setTimeout(() => {
      filesApi
        .search(scope, q)
        .then((res) => {
          if (seq !== searchSeq.current) return
          setTruncated(res.truncated)
          setHits(res.hits.map((h) => ({ key: h.path, name: h.name, path: h.path, dir: h.dir, isDirectory: false })))
        })
        .catch((err: Error) => {
          if (seq === searchSeq.current) setError(err.message)
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [query, scope])

  const root = listing?.root ?? rootOverride ?? ''
  const rootName = baseName(root) || t('filesBrowser.title')
  const crumbs = useMemo(() => breadcrumbs(path, rootName), [path, rootName])

  const rows: Row[] = useMemo(() => {
    if (hits) return hits
    return (listing?.entries ?? []).map((e: FileDirEntry) => ({
      key: e.path,
      name: e.name,
      path: e.path,
      dir: parentPath(e.path),
      isDirectory: e.isDirectory,
      size: e.size,
    }))
  }, [hits, listing])

  const go = (nextPath: string) =>
    router.push({ pathname: '/(main)/files', params: { sessionId, root: root || undefined, path: nextPath } })

  const open = (row: Row) => {
    if (row.isDirectory) go(row.path)
    else router.push({ pathname: '/(main)/files/view', params: { sessionId, root: root || undefined, path: row.path } })
  }

  const roots = listing?.roots ?? []

  return (
    <SafeScreen>
      <ListHeader title={path ? baseName(path) : rootName} subtitle={path || undefined} onBack={() => router.back()} />

      <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
        <SearchField value={query} onChange={setQuery} placeholder={t('filesBrowser.searchPlaceholder')} />
      </View>

      {!hits && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.crumbs} contentContainerStyle={s.crumbsContent}>
          {crumbs.map((crumb, i) => (
            <View key={crumb.path} style={s.crumbItem}>
              {i > 0 && <ChevronRight size={14} color={tokens.mutedForeground} />}
              <Pressable onPress={() => (i === crumbs.length - 1 ? undefined : go(crumb.path))} hitSlop={6}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: i === crumbs.length - 1 ? '700' : '500',
                    color: i === crumbs.length - 1 ? tokens.foreground : tokens.mutedForeground,
                  }}
                >
                  {crumb.name}
                </Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      {!hits && roots.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.rootsRow}>
          {roots.map((r) => {
            const active = r === root
            return (
              <Pressable
                key={r}
                onPress={() => {
                  setRootOverride(r)
                  router.replace({ pathname: '/(main)/files', params: { sessionId, root: r } })
                }}
                style={[s.rootChip, { borderColor: tokens.border, backgroundColor: active ? tokens.accent : 'transparent' }]}
              >
                <FolderTree size={13} color={tokens.foreground} />
                <Text style={{ fontSize: 12.5, color: tokens.foreground }}>{baseName(r)}</Text>
              </Pressable>
            )
          })}
        </ScrollView>
      )}

      {loading && !listing ? (
        <View style={s.center}>
          <ActivityIndicator color={tokens.mutedForeground} />
        </View>
      ) : error && !listing ? (
        <View style={s.center}>
          <Text style={{ color: tokens.destructive, textAlign: 'center', paddingHorizontal: 24 }}>
            {t('filesBrowser.loadFailed', { error })}
          </Text>
          <Pressable onPress={load} style={[s.retry, { borderColor: tokens.border }]}>
            <Text style={{ color: tokens.foreground, fontWeight: '600' }}>{t('filesBrowser.retry')}</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 32, paddingTop: 6 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}
          ListHeaderComponent={
            hits && truncated ? (
              <Text style={{ fontSize: 12, color: tokens.mutedForeground, padding: 10 }}>{t('filesBrowser.truncated')}</Text>
            ) : null
          }
          ListEmptyComponent={
            <View style={s.center}>
              <Text style={{ color: tokens.mutedForeground }}>
                {hits ? t('filesBrowser.noResults') : t('filesBrowser.empty')}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable onPress={() => open(item)} style={({ pressed }) => [s.row, pressed && { backgroundColor: tokens.accent }]}>
              <FileIcon name={item.name} isDirectory={item.isDirectory} color={item.isDirectory ? '#3b82f6' : tokens.mutedForeground} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ fontSize: 15, color: tokens.foreground }}>
                  {item.name}
                </Text>
                {hits && item.dir ? (
                  <Text numberOfLines={1} style={{ fontSize: 12, color: tokens.mutedForeground }}>
                    {item.dir}
                  </Text>
                ) : null}
              </View>
              {item.isDirectory ? (
                <ChevronRight size={16} color={tokens.mutedForeground} />
              ) : (
                <Text style={{ fontSize: 12, color: tokens.mutedForeground }}>{formatBytes(item.size)}</Text>
              )}
            </Pressable>
          )}
        />
      )}
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  crumbs: { flexGrow: 0, marginTop: 6 },
  crumbsContent: { paddingHorizontal: 14, paddingVertical: 8, gap: 4, alignItems: 'center' },
  crumbItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  rootsRow: { paddingHorizontal: 12, paddingBottom: 6, gap: 8 },
  rootChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 99, paddingHorizontal: 12, height: 32 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 48 },
  retry: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 10, minHeight: 48, paddingVertical: 8, borderRadius: 12 },
})
