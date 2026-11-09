/**
 * The folder browser of the app — recent folders, the current path with "use this folder"
 * and the subfolders. It is a body, not a modal: the "+" sheet shows it as a page and the
 * FolderSelector wraps it in the modal of the routines/pipeline forms.
 */
import { useCallback, useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native'
import { Folder, FolderUp, Check } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { ListDirsResponse } from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'
import { loadRecentFolders } from '~/lib/folder-recents'
import { folderName } from '~/lib/folder-name'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface DirBrowserBodyProps {
  /** False while the host is closed: the listing is (re)loaded every time it opens. */
  active: boolean
  onPick: (path: string) => void
}

export function DirBrowserBody({ active, onPick }: DirBrowserBodyProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const wsClient = useConnectionStore((s) => s.wsClient)
  const [listing, setListing] = useState<ListDirsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState<string[]>([])

  const browse = useCallback(
    async (path?: string, isCancelled?: () => boolean) => {
      setLoading(true)
      setError(null)
      try {
        const res = await wsClient.send({ type: 'fs:list-dirs', path })
        if (isCancelled?.()) return
        if (res.ok && res.data) {
          setListing(res.data as ListDirsResponse)
        } else {
          setError(res.error ?? t('folderSelector.listError'))
        }
      } catch (err) {
        if (!isCancelled?.()) setError(String(err))
      } finally {
        if (!isCancelled?.()) setLoading(false)
      }
    },
    [wsClient, t],
  )

  useEffect(() => {
    if (!active) return
    let cancelled = false
    // Fetching/syncing data in an effect is the documented React pattern;
    // the setState the rule flags is the loading/reset marker that
    // MUST happen before the await, otherwise the screen shows stale data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void browse(undefined, () => cancelled)
    void loadRecentFolders().then((list) => {
      if (!cancelled) setRecent(list)
    })
    return () => {
      cancelled = true
    }
  }, [active, browse])

  return (
    <View style={{ flex: 1 }}>
      {recent.length > 0 && (
        <View style={s.recents}>
          <Text style={[s.recentsLabel, { color: tokens.mutedForeground }]}>
            {t('folderSelector.recentFolders')}
          </Text>
          <View style={s.recentsWrap}>
            {recent.map((path) => (
              <Pressable
                key={path}
                onPress={() => onPick(path)}
                style={[s.recentChip, { borderColor: tokens.muted, backgroundColor: tokens.border }]}
              >
                <Folder size={11} color={tokens.mutedForeground} />
                <Text style={[s.recentChipText, { color: tokens.foreground }]} numberOfLines={1}>
                  {folderName(path)}
                </Text>
              </Pressable>
            ))}
          </View>
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
          <Text style={[s.useBtnText, { color: tokens.primaryForeground }]}>
            {t('folderSelector.useThis')}
          </Text>
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
              <Text style={[s.dirName, { color: tokens.foreground }]} numberOfLines={1}>
                {dir.name}
              </Text>
            </Pressable>
          ))
        )}
        {!loading && !error && listing?.dirs.length === 0 && (
          <Text style={[s.emptyText, { color: tokens.mutedForeground }]}>
            {t('folderSelector.noSubfolders')}
          </Text>
        )}
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  recents: { marginBottom: 10 },
  recentsLabel: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  recentsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
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

  dirRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 11,
    borderRadius: 10,
  },
  dirName: { flex: 1, fontSize: 14 },
  errorText: { padding: 16, fontSize: 13 },
  emptyText: { padding: 16, fontSize: 13 },
})
