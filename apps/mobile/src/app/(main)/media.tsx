/**
 * Media screen — mirror of the desktop's gallery: search, two filters with an icon (Type and Scope),
 * a square grid where every tile wears the icon of its type, a stack of versions for an image that was
 * edited, selection in bulk, and the disk usage. The scope is ONE filter (this conversation, a sidebar
 * folder, a repository, none of that) and the type filter lists only the types that exist.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, FlatList, ActivityIndicator, useWindowDimensions, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { ChevronDown, Folder, HardDrive, ImageOff, Inbox, LayoutGrid, MessageSquare, RefreshCw, SquareCheckBig, Trash2 } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { folderKey, normalizeFolderName, type MediaEntry, type MediaKind } from '@orbit/shared'
import { KIND_ORDER, entryTitle, kindOf } from '~/lib/media'
import { expandToGroups, groupMediaByRoot } from '~/lib/media-groups'
import { useSessionStore } from '~/stores/session-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useDraftFolders } from '~/stores/draft-folders-store'
import { useMediaStore } from '~/stores/media-store'
import { useConnectionStore } from '~/stores/connection-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { ImageLightbox } from '~/components/chat/ImageLightbox'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { FootLine, ListHeader, SearchField, useTokens } from '~/components/list/parts'
import { MediaTile, KIND_ICON } from '~/components/media/media-tile'
import { MediaPreview } from '~/components/media/media-preview'
import { FilterSelect, OptionSheet, type SheetOption } from '~/components/media/option-sheet'

type KindFilter = 'all' | MediaKind

const SCOPE_ALL = 'all'
const SCOPE_SESSION = 'session'
/** Media that belongs neither to a folder nor to a repository — the one of a loose chat. */
const SCOPE_LOOSE = '__loose__'
const FOLDER_PREFIX = 'folder:'
const PROJECT_PREFIX = 'project:'
const COLUMNS = 3
const GAP = 8
const SIDE = 16

/**
 * Design canvas, motion piece and slides deck are APP ASSETS, not conversation media: their folder
 * lives in Orbit's storage and stays valid outside the conversation, so the scope does not hide
 * them — only the type filter does.
 */
function isAppAsset(entry: MediaEntry): boolean {
  const kind = kindOf(entry)
  return kind === 'design' || kind === 'motion' || kind === 'slides'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function MediaScreen() {
  const { t, i18n } = useTranslation()
  const router = useRouter()
  const tokens = useTokens()
  const { width } = useWindowDimensions()
  const tile = Math.floor((width - SIDE * 2 - GAP * (COLUMNS - 1)) / COLUMNS)

  const mode = useWorkspaceStore((s) => s.mode)
  const setMode = useWorkspaceStore((s) => s.setMode)
  const sessions = useSessionStore((s) => s.sessions)
  const sidebarFolders = useSessionStore((s) => s.folders)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const http = useConnectionStore((s) => s.http)
  const draftFolders = useDraftFolders((s) => s.folders)
  const hydrateFolders = useDraftFolders((s) => s.hydrate)

  const entries = useMediaStore((s) => s.entries)
  const usage = useMediaStore((s) => s.usage)
  const loading = useMediaStore((s) => s.loading)
  const refreshing = useMediaStore((s) => s.refreshing)
  const refresh = useMediaStore((s) => s.refresh)
  const remove = useMediaStore((s) => s.remove)
  const removeOne = useMediaStore((s) => s.removeOne)
  const confirm = useConfirm()

  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  /** Explicit choice of the user; null = follow the default scope. */
  const [scopeOverride, setScopeOverride] = useState<string | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [sheet, setSheet] = useState<'kind' | 'scope' | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selecting, setSelecting] = useState(false)
  const [preview, setPreview] = useState<MediaEntry | null>(null)
  const [previewChain, setPreviewChain] = useState<MediaEntry[] | null>(null)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    if (http) void refresh()
  }, [http, refresh])
  useEffect(() => {
    void hydrateFolders()
  }, [hydrateFolders])

  /** Sessions of the current mode — the gallery shows chat media in chat mode and code media in code mode. */
  const modeSessionIds = useMemo(() => new Set(sessions.filter((s) => s.mode === mode).map((s) => s.id)), [sessions, mode])
  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  const folderNameById = useMemo(() => new Map(sidebarFolders.map((f) => [f.id, f.name])), [sidebarFolders])

  /** Repository of an entry: the directory of the session that made it, normalized like the sidebar folders. */
  const projectOf = useCallback(
    (entry: MediaEntry): { key: string; label: string } | null => {
      if (!entry.sessionId) return null
      const directory = sessionById.get(entry.sessionId)?.directory
      if (!directory) return null
      const label = normalizeFolderName(directory)
      return { key: folderKey(label), label }
    },
    [sessionById],
  )
  /** Sidebar folder of an entry, through the session that made it. */
  const folderOf = useCallback(
    (entry: MediaEntry): { id: string; name: string } | null => {
      if (!entry.sessionId) return null
      const folderId = sessionById.get(entry.sessionId)?.folderId
      const name = folderId ? folderNameById.get(folderId) : undefined
      return folderId && name ? { id: folderId, name } : null
    },
    [sessionById, folderNameById],
  )

  const scopedEntries = useMemo(() => entries.filter((e) => !e.sessionId || modeSessionIds.has(e.sessionId)), [entries, modeSessionIds])

  /** Does an entry fall in this scope? The single rule — filter, default and the list all ask here. */
  const matchesScope = useCallback(
    (entry: MediaEntry, value: string): boolean => {
      if (value === SCOPE_ALL) return true
      if (value === SCOPE_SESSION) return !!activeSessionId && (entry.sessionId === activeSessionId || !!entry.linkedSessionIds?.includes(activeSessionId))
      if (value === SCOPE_LOOSE) return !folderOf(entry) && !projectOf(entry)
      if (value.startsWith(FOLDER_PREFIX)) return folderOf(entry)?.id === value.slice(FOLDER_PREFIX.length)
      if (value.startsWith(PROJECT_PREFIX)) return projectOf(entry)?.key === value.slice(PROJECT_PREFIX.length)
      return true
    },
    [activeSessionId, folderOf, projectOf],
  )

  const scopeOptions = useMemo<SheetOption[]>(() => {
    const count = (value: string) => scopedEntries.filter((e) => isAppAsset(e) || matchesScope(e, value)).length
    const folders = new Map<string, string>()
    const projects = new Map<string, string>()
    for (const entry of scopedEntries) {
      const f = folderOf(entry)
      if (f) folders.set(f.id, f.name)
      const p = projectOf(entry)
      if (p) projects.set(p.key, p.label)
    }
    const out: SheetOption[] = [{ value: SCOPE_ALL, label: t('media.scope.all'), icon: LayoutGrid, count: scopedEntries.length }]
    if (activeSessionId) out.push({ value: SCOPE_SESSION, label: t('media.scope.session'), icon: MessageSquare, count: count(SCOPE_SESSION) })
    for (const [id, name] of [...folders].sort((a, b) => a[1].localeCompare(b[1]))) {
      out.push({ value: `${FOLDER_PREFIX}${id}`, label: t('media.scope.folder', { name }), icon: Folder, count: count(`${FOLDER_PREFIX}${id}`) })
    }
    for (const [key, label] of [...projects].sort((a, b) => a[1].localeCompare(b[1]))) {
      out.push({ value: `${PROJECT_PREFIX}${key}`, label: t('media.scope.project', { name: label }), icon: Folder, count: count(`${PROJECT_PREFIX}${key}`) })
    }
    if (scopedEntries.some((e) => !isAppAsset(e) && !folderOf(e) && !projectOf(e))) {
      out.push({ value: SCOPE_LOOSE, label: t('media.scope.loose'), icon: Inbox, count: count(SCOPE_LOOSE) })
    }
    return out
  }, [scopedEntries, matchesScope, folderOf, projectOf, activeSessionId, t])

  /**
   * The scope the gallery opens with when nothing was chosen yet: the most specific the context offers —
   * the sidebar folder of the conversation, then its repository, then (a loose chat) the conversation
   * itself. Each one only counts if it has media, so the gallery never opens empty because of a filter.
   */
  const defaultScope = useMemo(() => {
    const has = (value: string) => scopedEntries.some((e) => !isAppAsset(e) && matchesScope(e, value))
    const active = activeSessionId ? sessionById.get(activeSessionId) : undefined
    if (active?.folderId) {
      const value = `${FOLDER_PREFIX}${active.folderId}`
      if (has(value)) return value
    }
    const directory = active?.directory ?? draftFolders[0]
    if (directory) {
      const value = `${PROJECT_PREFIX}${folderKey(normalizeFolderName(directory))}`
      if (has(value)) return value
    }
    if (active && has(SCOPE_SESSION)) return SCOPE_SESSION
    return SCOPE_ALL
  }, [scopedEntries, matchesScope, activeSessionId, sessionById, draftFolders])

  const scope = scopeOverride && scopeOptions.some((o) => o.value === scopeOverride) ? scopeOverride : defaultScope

  const kindOptions = useMemo<SheetOption[]>(() => {
    const counts = new Map<string, number>()
    for (const e of scopedEntries) counts.set(kindOf(e), (counts.get(kindOf(e)) ?? 0) + 1)
    const out: SheetOption[] = [{ value: 'all', label: t('media.kind.all'), icon: LayoutGrid, count: scopedEntries.length }]
    for (const value of KIND_ORDER) {
      if (counts.has(value)) out.push({ value, label: t(`media.kind.${value}`), icon: KIND_ICON[value], count: counts.get(value) })
    }
    return out
  }, [scopedEntries, t])
  const kindValue = kindOptions.some((o) => o.value === kind) ? kind : 'all'

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return scopedEntries.filter((entry) => {
      if (kindValue !== 'all' && kindOf(entry) !== kindValue) return false
      if (!isAppAsset(entry) && !matchesScope(entry, scope)) return false
      if (!needle) return true
      return `${entry.name ?? ''} ${entry.taskId ?? ''} ${entry.id}`.toLowerCase().includes(needle)
    })
  }, [scopedEntries, kindValue, scope, query, matchesScope])

  /** A photo and its versions are ONE tile. */
  const { covers, versions } = useMemo(() => groupMediaByRoot(entries, visible), [entries, visible])

  const activeFilters = (kindValue !== 'all' ? 1 : 0) + (scope !== SCOPE_ALL ? 1 : 0)
  const currentKind = kindOptions.find((o) => o.value === kindValue)
  const currentScope = scopeOptions.find((o) => o.value === scope)

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const enterSelection = useCallback((id?: string) => {
    setSelecting(true)
    setSelected(new Set(id ? [id] : []))
  }, [])
  const exitSelection = useCallback(() => {
    setSelecting(false)
    setSelected(new Set())
  }, [])

  const closePreview = useCallback(() => {
    setPreview(null)
    setPreviewChain(null)
    setFullscreen(false)
  }, [])
  const openEntry = useCallback(
    (entry: MediaEntry) => {
      setPreview(entry)
      setPreviewChain(versions.get(entry.id) ?? null)
    },
    [versions],
  )
  const stepVersion = useCallback(
    (delta: number) => {
      if (!preview || !previewChain) return
      const next = previewChain[previewChain.findIndex((v) => v.id === preview.id) + delta]
      if (next) setPreview(next)
    },
    [preview, previewChain],
  )

  /** A grid item is the whole group: deleting it deletes every version, and the confirmation says how many files that is. */
  const removeIds = useCallback(
    async (ids: string[], name?: string) => {
      const all = expandToGroups(ids, entries)
      const ok = await confirm({
        title: all.length > 1 ? t('media.deleteSelectedTitle_other', { count: all.length }) : t('media.deleteTitle'),
        description: all.length > 1 ? t('media.deleteSelectedBody') : t('media.deleteBody', { name: name ?? '' }),
        confirmLabel: t('media.delete'),
        cancelLabel: t('sidebar.cancel'),
        destructive: true,
      })
      if (!ok) return false
      if (all.length === 1) await removeOne(all[0])
      else await remove(all)
      return true
    },
    [entries, confirm, remove, removeOne, t],
  )

  const removeSelected = useCallback(async () => {
    if (selected.size === 0) return
    if (await removeIds([...selected])) exitSelection()
  }, [selected, removeIds, exitSelection])

  /** Opens the source chat of the item, switching the mode if needed. */
  const openInChat = useCallback(
    (entry: MediaEntry) => {
      if (!entry.sessionId) return
      const session = useSessionStore.getState().sessions.find((s) => s.id === entry.sessionId)
      if (!session) return
      setMode(session.mode === 'code' ? 'code' : 'chat')
      closePreview()
      router.push({ pathname: '/(main)/chat/[id]', params: { id: session.id } })
    },
    [router, setMode, closePreview],
  )

  const handleRefresh = useCallback(() => void refresh(), [refresh])
  const usageText = t('media.usage', { count: usage.count, size: formatBytes(usage.bytes) })

  return (
    <SafeScreen style={s.container}>
      <ListHeader
        title={selecting ? t('media.selectedCount', { count: selected.size }) : t('media.title')}
        subtitle={selecting ? t('media.selectHint') : usageText}
        onBack={selecting ? exitSelection : () => router.back()}
        right={
          selecting ? (
            <Pressable
              onPress={() => void removeSelected()}
              disabled={selected.size === 0}
              accessibilityRole="button"
              style={[s.deleteBtn, { borderColor: tokens.border, opacity: selected.size === 0 ? 0.4 : 1 }]}
            >
              <Trash2 size={15} color={tokens.destructive} />
              <Text style={{ fontSize: 13, fontWeight: '500', color: tokens.destructive }}>{t('media.delete')}</Text>
            </Pressable>
          ) : (
            <View style={{ flexDirection: 'row' }}>
              <Pressable onPress={() => enterSelection()} accessibilityRole="button" accessibilityLabel={t('media.select')} style={s.iconBtn}>
                <SquareCheckBig size={20} color={tokens.foreground} />
              </Pressable>
              <Pressable onPress={handleRefresh} accessibilityRole="button" accessibilityLabel={t('media.refresh')} style={s.iconBtn}>
                {refreshing ? <ActivityIndicator size="small" color={tokens.mutedForeground} /> : <RefreshCw size={19} color={tokens.foreground} />}
              </Pressable>
            </View>
          )
        }
      />

      <View style={s.bar}>
        <SearchField value={query} onChange={setQuery} placeholder={t('media.searchPlaceholder')} />
      </View>
      {/* The count on the left and the filters' trigger on the right, on the same line. */}
      <View style={s.infoRow}>
        <Text style={{ fontSize: 12, color: tokens.mutedForeground }}>{!loading && covers.length > 0 ? t('media.itemsCount', { count: covers.length }) : ''}</Text>
        <Pressable onPress={() => setFiltersOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: filtersOpen }} style={s.filtersToggle}>
          <Text style={{ fontSize: 12.5, color: tokens.mutedForeground }}>
            {t(filtersOpen ? 'media.filters.hide' : 'media.filters.show')}
            {!filtersOpen && activeFilters > 0 ? <Text style={{ color: tokens.foreground }}> ({activeFilters})</Text> : null}
          </Text>
          <ChevronDown size={14} color={tokens.mutedForeground} style={{ transform: [{ rotate: filtersOpen ? '180deg' : '0deg' }] }} />
        </Pressable>
      </View>
      {filtersOpen ? (
        <View style={s.selects}>
          <FilterSelect option={currentKind} active={kindValue !== 'all'} onPress={() => setSheet('kind')} accessibilityLabel={t('media.filters.kind')} />
          <FilterSelect option={currentScope} active={scope !== SCOPE_ALL} onPress={() => setSheet('scope')} accessibilityLabel={t('media.filters.scope')} />
        </View>
      ) : null}

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={tokens.primary} />
        </View>
      ) : covers.length === 0 ? (
        <View style={s.center}>
          <ImageOff size={26} color={tokens.mutedForeground} />
          <Text style={{ fontSize: 13, color: tokens.mutedForeground }}>{t('media.empty')}</Text>
        </View>
      ) : (
        <FlatList
          data={covers}
          keyExtractor={(item) => item.id}
          numColumns={COLUMNS}
          columnWrapperStyle={{ gap: GAP, marginBottom: GAP }}
          contentContainerStyle={{ paddingHorizontal: SIDE, paddingTop: 6, paddingBottom: 12 }}
          refreshing={refreshing}
          onRefresh={handleRefresh}
          renderItem={({ item }) => (
            <MediaTile
              entry={item}
              size={tile}
              versions={versions.get(item.id)?.length ?? 1}
              selecting={selecting}
              selected={selected.has(item.id)}
              onOpen={() => openEntry(item)}
              onToggle={() => toggle(item.id)}
              onLongPress={() => (selecting ? toggle(item.id) : enterSelection(item.id))}
            />
          )}
        />
      )}

      <FootLine icon={HardDrive} text={usageText} />

      <OptionSheet open={sheet === 'kind'} title={t('media.filters.kind')} options={kindOptions} value={kindValue} closeLabel={t('media.close')} onPick={(v) => { setKind(v as KindFilter); setSheet(null) }} onClose={() => setSheet(null)} />
      <OptionSheet open={sheet === 'scope'} title={t('media.filters.scope')} options={scopeOptions} value={scope} closeLabel={t('media.close')} onPick={(v) => { setScopeOverride(v); setSheet(null) }} onClose={() => setSheet(null)} />

      <MediaPreview
        entry={preview}
        chain={previewChain}
        locale={i18n.language}
        onStep={stepVersion}
        onPick={setPreview}
        onClose={closePreview}
        onExpand={() => setFullscreen(true)}
        onOpenInChat={openInChat}
        onDelete={async (entry) => {
          if (await removeIds([entry.id], entryTitle(entry))) closePreview()
        }}
      />
      {/* Fullscreen with zoom (same viewer as the chat) — only the image has something to zoom. */}
      {preview?.url && kindOf(preview) === 'image' ? <ImageLightbox src={preview.url} alt={preview.name} open={fullscreen} onOpenChange={setFullscreen} /> : null}
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  deleteBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 12, marginRight: 6, borderWidth: 1, borderRadius: 10 },
  bar: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 },
  infoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36, paddingHorizontal: 18 },
  filtersToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36 },
  selects: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
})
