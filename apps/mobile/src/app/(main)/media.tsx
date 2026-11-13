import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, FlatList, TextInput, Modal, StyleSheet, ActivityIndicator, ScrollView } from 'react-native'
import { useRouter } from 'expo-router'
import { Image } from 'expo-image'
import {
  ArrowLeft,
  Search,
  RefreshCw,
  Trash2,
  X,
  HardDrive,
  CheckSquare,
  ImageOff,
  Maximize2,
  MessageSquare,
  Check,
  Image as ImageIcon,
  FileCode2,
  FileText,
  Video,
  Music,
  Clapperboard,
  PenTool,
  Presentation,
  Play,
  Pause,
} from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { folderKey, normalizeFolderName, type MediaEntry, type MediaKind, type MediaSource } from '@orbit/shared'
import { VideoView, useVideoPlayer } from 'expo-video'
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio'
import { WebView } from 'react-native-webview'
import { KIND_KEY, KIND_ORDER, canOpen, entryTitle, kindOf } from '~/lib/media'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useConnectionStore } from '~/stores/connection-store'
import { useSessionStore } from '~/stores/session-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useDraftFolders } from '~/stores/draft-folders-store'
import { useMediaStore } from '~/stores/media-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { ImageLightbox } from '~/components/chat/ImageLightbox'
import { useConfirm } from '~/components/ui/confirm-dialog'

type SourceFilter = 'all' | MediaSource
type PeriodFilter = 'all' | 'today' | 'week' | 'month'
type KindFilter = 'all' | MediaKind

/** Project filter: 'all' = everything; '__none__' = media with no known project. */
const PROJECT_ALL = 'all'
const PROJECT_NONE = '__none__'

const PERIOD_MS: Record<Exclude<PeriodFilter, 'all'>, number> = {
  today: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** The icon of each type on the tile card (images come out in the thumbnail). */
const KIND_ICON: Record<MediaKind, typeof ImageIcon> = {
  image: ImageIcon,
  artifact: FileCode2,
  document: FileText,
  video: Video,
  audio: Music,
  motion: Clapperboard,
  design: PenTool,
  slides: Presentation,
}

// ─── Viewers per type ────────────────────────────────────────────────────────

/** Page (artifact, document, piece): the WebView loads the URL already with the token. */
function PageViewer({ url }: { url: string }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <WebView
      source={{ uri: url }}
      style={s.pageViewer}
      // The artifact comes from the desktop, on a local http: only http/https navigate
      // here, no external scheme (tel:, intent:) becoming a system action.
      originWhitelist={['http://*', 'https://*']}
      startInLoadingState
      renderLoading={() => (
        <View style={[s.pageViewer, s.pageLoading, { backgroundColor: tokens.background }]}>
          <ActivityIndicator color={tokens.primary} />
        </View>
      )}
      // Links inside the page open in the page itself (the path token is inherited
      // by the relative ones: that is how `base.css` and the fonts load).
      setSupportMultipleWindows={false}
    />
  )
}

/** Video: the native expo-video player, with the system controls. */
function VideoViewer({ url }: { url: string }) {
  const player = useVideoPlayer(url)
  return <VideoView player={player} style={s.mediaFill} contentFit="contain" nativeControls />
}

/** Audio: there is no image to show, so the card becomes a minimal player. */
function AudioViewer({ url, title }: { url: string; title: string }) {
  const player = useAudioPlayer(url)
  const status = useAudioPlayerStatus(player)
  useEffect(() => {
    // On iOS the silent switch would mute the player — the gallery is for listening.
    void setAudioModeAsync({ playsInSilentMode: true }).catch(() => {})
  }, [])
  return (
    <View style={s.audioWrap}>
      <Music size={44} color="#fff" />
      <Text style={s.audioTitle} numberOfLines={2}>{title}</Text>
      <Pressable
        onPress={() => (status.playing ? player.pause() : player.play())}
        style={s.audioPlay}
        accessibilityRole="button"
      >
        {status.playing ? <Pause size={22} color="#000" /> : <Play size={22} color="#000" />}
      </Pressable>
      <Text style={s.audioTime}>
        {formatClock(status.currentTime)} / {formatClock(status.duration)}
      </Text>
    </View>
  )
}

/** What opens in place of the preview, chosen by the type of the entry. */
function EntryViewer({ entry, onExpand }: { entry: MediaEntry; onExpand: () => void }) {
  const { t } = useTranslation()
  const kind = kindOf(entry)
  if (!canOpen(entry)) {
    // Piece missing from the desktop registry: the item is in the index but the file is not.
    return (
      <View style={s.pageLoading}>
        <ImageOff size={28} color="#fff" />
        <Text style={s.audioTime}>{t('media.fileUnavailable')}</Text>
      </View>
    )
  }
  const url = entry.url as string
  if (kind === 'image') {
    return (
      <Pressable style={s.previewImgWrap} onPress={onExpand}>
        <Image source={url} style={s.previewImg} contentFit="contain" />
        <View style={s.expandBadge}>
          <Maximize2 size={14} color="#fff" />
        </View>
      </Pressable>
    )
  }
  if (kind === 'video') return <VideoViewer url={url} />
  if (kind === 'audio') return <AudioViewer url={url} title={entryTitle(entry)} />
  // The rest is page: artifact, document (.html preview) and the pieces.
  return <PageViewer url={url} />
}

export default function MediaScreen() {
  const { t, i18n } = useTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const mode = useWorkspaceStore((s) => s.mode)
  const setMode = useWorkspaceStore((s) => s.setMode)
  const sessions = useSessionStore((s) => s.sessions)
  const http = useConnectionStore((s) => s.http)
  const folders = useDraftFolders((s) => s.folders)
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
  const [source, setSource] = useState<SourceFilter>('all')
  const [kind, setKind] = useState<KindFilter>('all')
  const [period, setPeriod] = useState<PeriodFilter>('all')
  /** Explicit user filter; null = follow the default (project of the selected folder). */
  const [projectOverride, setProjectOverride] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectionMode, setSelectionMode] = useState(false)
  const [preview, setPreview] = useState<MediaEntry | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  // Time reference for the period filter, updated on every refresh —
  // it avoids calling Date.now() during the render (react-hooks/purity).
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (http) void refresh()
  }, [http, refresh])

  // Recent folders (the "selected folder" of the app) — feeds the default filter.
  useEffect(() => {
    void hydrateFolders()
  }, [hydrateFolders])

  const handleRefresh = useCallback(() => {
    setNow(Date.now())
    void refresh()
  }, [refresh])

  /** Sessions of the current mode — scope of the gallery (chat shows only chat, etc). */
  const modeSessionIds = useMemo(
    () => new Set(sessions.filter((s) => s.mode === mode).map((s) => s.id)),
    [sessions, mode],
  )

  /**
   * Project of an entry: the directory of the session that originated it, normalized
   * with the SAME rule as the sidebar folders (folderKey/normalizeFolderName).
   * An entry with no known session (orphan of the backfill) or a session with no directory
   * (chat mode) has no project.
   */
  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  const projectOf = useCallback((entry: MediaEntry): { key: string; label: string } | null => {
    if (!entry.sessionId) return null
    const directory = sessionById.get(entry.sessionId)?.directory
    if (!directory) return null
    const label = normalizeFolderName(directory)
    return { key: folderKey(label), label }
  }, [sessionById])

  /** Entries in the scope of the current mode (applies the session filter once only). */
  const scopedEntries = useMemo(
    () => entries.filter((entry) => !entry.sessionId || modeSessionIds.has(entry.sessionId)),
    [entries, modeSessionIds],
  )

  /** Types present in the scope — only those that have an item become a chip. */
  const kindOptions = useMemo(() => {
    const present = new Set(scopedEntries.map((entry) => kindOf(entry)))
    return KIND_ORDER.filter((value) => present.has(value))
  }, [scopedEntries])

  /** Projects with media in the scope — the filter chips. */
  const projectOptions = useMemo(() => {
    const byKey = new Map<string, string>()
    for (const entry of scopedEntries) {
      const p = projectOf(entry)
      if (p && !byKey.has(p.key)) byKey.set(p.key, p.label)
    }
    return [...byKey.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [scopedEntries, projectOf])

  const hasProjectless = useMemo(
    () => scopedEntries.some((entry) => !projectOf(entry)),
    [scopedEntries, projectOf],
  )

  /** Project of the selected folder (folders[0]) — the default filter. */
  const defaultProjectKey = useMemo(() => {
    if (!folders[0]) return null
    return folderKey(normalizeFolderName(folders[0]))
  }, [folders])

  const defaultProjectHasMedia = useMemo(
    () => !!defaultProjectKey && scopedEntries.some((entry) => projectOf(entry)?.key === defaultProjectKey),
    [defaultProjectKey, scopedEntries, projectOf],
  )

  const projectOptionKeys = useMemo(() => new Set(projectOptions.map((p) => p.key)), [projectOptions])

  /**
   * Effective filter: the one chosen by the user when it is valid; if it left the
   * scope (e.g. changed mode and the project has no media here) or nothing was
   * chosen, it falls back to the default — the project of the selected folder, when it has
   * media — and only then to "all". All derived: no setState in effect.
   */
  const project = useMemo(() => {
    if (projectOverride === PROJECT_ALL || projectOverride === PROJECT_NONE) return projectOverride
    if (projectOverride && projectOptionKeys.has(projectOverride)) return projectOverride
    if (defaultProjectKey && defaultProjectHasMedia) return defaultProjectKey
    return PROJECT_ALL
  }, [projectOverride, projectOptionKeys, defaultProjectKey, defaultProjectHasMedia])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const since = period === 'all' ? 0 : now - PERIOD_MS[period]
    return scopedEntries.filter((entry) => {
      if (source !== 'all' && entry.source !== source) return false
      if (kind !== 'all' && kindOf(entry) !== kind) return false
      if (project === PROJECT_NONE) {
        if (projectOf(entry)) return false
      } else if (project !== PROJECT_ALL) {
        const p = projectOf(entry)
        if (!p || p.key !== project) return false
      }
      if (entry.createdAt < since) return false
      if (!needle) return true
      return `${entry.name ?? ''} ${entry.taskId ?? ''} ${entry.id}`.toLowerCase().includes(needle)
    })
  }, [scopedEntries, source, kind, period, query, project, projectOf, now])

  const selecting = selectionMode

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const enterSelection = useCallback((id?: string) => {
    setSelectionMode(true)
    setSelected(new Set(id ? [id] : []))
  }, [])

  const exitSelection = useCallback(() => {
    setSelectionMode(false)
    setSelected(new Set())
  }, [])

  const removeSelected = useCallback(async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    const ok = await confirm({
      title:
        ids.length > 1
          ? t('media.deleteSelectedTitle_other', { count: ids.length })
          : t('media.deleteSelectedTitle_one', { count: ids.length }),
      description: t('media.deleteSelectedBody'),
      confirmLabel: t('media.delete'),
      cancelLabel: t('sidebar.cancel'),
      destructive: true,
    })
    if (!ok) return
    await remove(ids)
    exitSelection()
    setPreview((current) => (current && ids.includes(current.id) ? null : current))
  }, [selected, remove, exitSelection, confirm, t])

  /** Opens the source chat of the image, switching the mode if needed. */
  const openInChat = useCallback(
    (entry: MediaEntry) => {
      if (!entry.sessionId) return
      const session = useSessionStore.getState().sessions.find((s) => s.id === entry.sessionId)
      if (!session) return
      setMode(session.mode === 'code' ? 'code' : 'chat')
      setPreview(null)
      router.push({ pathname: '/(main)/chat/[id]', params: { id: session.id } })
    },
    [router, setMode],
  )

  const sourceFilters: SourceFilter[] = ['all', 'user', 'chat', 'screenshot', 'script', 'batch']
  const periodFilters: PeriodFilter[] = ['all', 'today', 'week', 'month']

  const renderThumb = ({ item }: { item: MediaEntry }) => {
    const isSelected = selected.has(item.id)
    const kind = kindOf(item)
    // Only the image becomes a thumbnail: the rest has nothing to draw in an <Image>
    // (it was the broken tile of the gallery), so it becomes a card with icon and title.
    const KindIcon = KIND_ICON[kind]
    return (
      <Pressable
        onPress={() => (selecting ? toggle(item.id) : setPreview(item))}
        onLongPress={() => {
          if (!selecting) enterSelection(item.id)
          else toggle(item.id)
        }}
        style={[s.thumb, { borderColor: isSelected ? tokens.primary : tokens.border, backgroundColor: tokens.muted }]}
      >
        {kind === 'image' ? (
          item.url ? (
            <Image source={item.url} style={s.thumbImg} contentFit="cover" transition={150} />
          ) : (
            <View style={s.thumbEmpty}>
              <ImageOff size={18} color={tokens.mutedForeground} />
            </View>
          )
        ) : (
          <View style={s.cardBody}>
            <KindIcon size={26} color={tokens.mutedForeground} />
            <Text style={[s.cardKind, { color: tokens.mutedForeground }]}>{t(KIND_KEY[kind])}</Text>
            <Text style={[s.cardTitle, { color: tokens.foreground }]} numberOfLines={2}>
              {entryTitle(item)}
            </Text>
          </View>
        )}
        {kind === 'image' && item.name ? (
          <View style={s.thumbLabelWrap}>
            <Text style={s.thumbLabel} numberOfLines={1}>{item.name}</Text>
          </View>
        ) : null}
        {selecting && (
          <View style={[s.checkBadge, { backgroundColor: isSelected ? tokens.primary : 'rgba(0,0,0,0.45)', borderColor: tokens.background }]}>
            {isSelected && <Check size={12} color="#fff" />}
          </View>
        )}
      </Pressable>
    )
  }

  return (
    <SafeScreen style={s.container}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('media.title')}</Text>
        {selecting ? (
          <Pressable onPress={exitSelection} style={s.headerBtn}>
            <X size={20} color={tokens.foreground} />
          </Pressable>
        ) : (
          <Pressable onPress={() => enterSelection()} style={s.headerBtn}>
            <CheckSquare size={20} color={tokens.foreground} />
          </Pressable>
        )}
      </View>

      {/* Search + refresh */}
      <View style={s.searchRow}>
        <View style={[s.searchBox, { backgroundColor: tokens.border }]}>
          <Search size={15} color={tokens.mutedForeground} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('media.searchPlaceholder')}
            placeholderTextColor={tokens.mutedForeground}
            style={[s.searchInput, { color: tokens.foreground }]}
          />
        </View>
        <Pressable onPress={handleRefresh} style={[s.refreshBtn, { borderColor: tokens.border }]}>
          <RefreshCw size={15} color={tokens.mutedForeground} />
        </Pressable>
      </View>

      {/* Filters — source and period, with a divider like on the desktop */}
      <View style={s.filtersWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filtersContent}>
          {(projectOptions.length > 0 || hasProjectless) && (
            <>
              <Pressable
                key="project-all"
                onPress={() => setProjectOverride(PROJECT_ALL)}
                style={[s.chip, { backgroundColor: project === PROJECT_ALL ? tokens.primary : tokens.border }]}
              >
                <Text style={[s.chipText, { color: project === PROJECT_ALL ? '#fff' : tokens.mutedForeground }]}>
                  {t('media.project.all')}
                </Text>
              </Pressable>
              {projectOptions.map((p) => (
                <Pressable
                  key={`project-${p.key}`}
                  onPress={() => setProjectOverride(p.key)}
                  style={[s.chip, { backgroundColor: project === p.key ? tokens.primary : tokens.border }]}
                >
                  <Text style={[s.chipText, { color: project === p.key ? '#fff' : tokens.mutedForeground }]}>
                    {p.label}
                  </Text>
                </Pressable>
              ))}
              {hasProjectless && (
                <Pressable
                  key="project-none"
                  onPress={() => setProjectOverride(PROJECT_NONE)}
                  style={[s.chip, { backgroundColor: project === PROJECT_NONE ? tokens.primary : tokens.border }]}
                >
                  <Text style={[s.chipText, { color: project === PROJECT_NONE ? '#fff' : tokens.mutedForeground }]}>
                    {t('media.project.none')}
                  </Text>
                </Pressable>
              )}
              <View style={[s.filtersDivider, { backgroundColor: tokens.border }]} />
            </>
          )}
          {sourceFilters.map((value) => (
            <Pressable
              key={`source-${value}`}
              onPress={() => setSource(value)}
              style={[s.chip, { backgroundColor: source === value ? tokens.primary : tokens.border }]}
            >
              <Text style={[s.chipText, { color: source === value ? '#fff' : tokens.mutedForeground }]}>
                {t(`media.source.${value}`)}
              </Text>
            </Pressable>
          ))}
          <View style={[s.filtersDivider, { backgroundColor: tokens.border }]} />
          {/* Type: the gallery holds image, artifact, document, video, audio and
              piece — the chip is what lets you find one without scrolling the whole list. */}
          <Pressable
            key="kind-all"
            onPress={() => setKind('all')}
            style={[s.chip, { backgroundColor: kind === 'all' ? tokens.primary : tokens.border }]}
          >
            <Text style={[s.chipText, { color: kind === 'all' ? '#fff' : tokens.mutedForeground }]}>
              {t('media.kind.all')}
            </Text>
          </Pressable>
          {kindOptions.map((value) => (
            <Pressable
              key={`kind-${value}`}
              onPress={() => setKind(value)}
              style={[s.chip, { backgroundColor: kind === value ? tokens.primary : tokens.border }]}
            >
              <Text style={[s.chipText, { color: kind === value ? '#fff' : tokens.mutedForeground }]}>
                {t(KIND_KEY[value])}
              </Text>
            </Pressable>
          ))}
          <View style={[s.filtersDivider, { backgroundColor: tokens.border }]} />
          {periodFilters.map((value) => (
            <Pressable
              key={`period-${value}`}
              onPress={() => setPeriod(value)}
              style={[s.chip, { backgroundColor: period === value ? tokens.primary : tokens.border }]}
            >
              <Text style={[s.chipText, { color: period === value ? '#fff' : tokens.mutedForeground }]}>
                {t(`media.period.${value}`)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* Selection bar */}
      {selecting && (
        <View style={[s.selectionBar, { backgroundColor: tokens.muted }]}>
          <Text style={[s.selectionCount, { color: tokens.foreground }]}>
            {t('media.selectedCount', { count: selected.size })}
          </Text>
          <Pressable
            onPress={() => void removeSelected()}
            disabled={selected.size === 0}
            style={[s.deleteBtn, { backgroundColor: tokens.destructive, opacity: selected.size === 0 ? 0.4 : 1 }]}
          >
            <Trash2 size={14} color="#fff" />
            <Text style={s.deleteBtnText}>{t('media.delete')}</Text>
          </Pressable>
          <Pressable onPress={exitSelection} style={s.cancelBtn}>
            <X size={16} color={tokens.mutedForeground} />
          </Pressable>
        </View>
      )}

      {/* Grade */}
      {loading ? (
        <View style={s.centerBox}>
          <ActivityIndicator color={tokens.primary} />
        </View>
      ) : visible.length === 0 ? (
        <View style={s.centerBox}>
          <ImageOff size={26} color={tokens.mutedForeground} />
          <Text style={[s.emptyText, { color: tokens.mutedForeground }]}>{t('media.empty')}</Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => item.id}
          renderItem={renderThumb}
          numColumns={2}
          columnWrapperStyle={s.gridRow}
          contentContainerStyle={s.gridContent}
          refreshing={refreshing}
          onRefresh={handleRefresh}
        />
      )}

      {/* Usage footer */}
      <View style={[s.footer, { borderTopColor: tokens.border }]}>
        <HardDrive size={13} color={tokens.mutedForeground} />
        <Text style={[s.footerText, { color: tokens.mutedForeground }]}>
          {t('media.usage', { count: usage.count, size: formatBytes(usage.bytes) })}
        </Text>
      </View>

      {/* Preview (detail + actions) */}
      <Modal visible={!!preview} transparent animationType="fade" onRequestClose={() => setPreview(null)} statusBarTranslucent>
        <View style={[s.previewWrap, { backgroundColor: 'rgba(0,0,0,0.92)' }]}>
          <View style={{ height: insets.top }} />
          <Pressable onPress={() => setPreview(null)} style={s.previewClose}>
            <X size={22} color="#fff" />
          </Pressable>
          {preview && (
            <>
              <View style={s.previewViewer}>
                <EntryViewer entry={preview} onExpand={() => setFullscreen(true)} />
              </View>
              <View style={[s.previewMeta, { paddingBottom: insets.bottom + 12 }]}>
                <Text style={s.previewName} numberOfLines={1}>{entryTitle(preview)}</Text>
                <Text style={s.previewSub}>
                  {t(`media.source.${preview.source}`)} · {formatDate(preview.createdAt, i18n.language)}
                  {preview.width && preview.height ? ` · ${preview.width}×${preview.height}` : ''} · {formatBytes(preview.size)}
                </Text>
                <View style={s.previewActions}>
                  {preview.sessionId && (
                    <Pressable onPress={() => openInChat(preview)} style={[s.previewAction, { borderColor: 'rgba(255,255,255,0.2)' }]}>
                      <MessageSquare size={15} color="#fff" />
                      <Text style={s.previewActionText}>{t('media.openInChat')}</Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={async () => {
                      const ok = await confirm({
                        title: t('media.deleteTitle'),
                        description: t('media.deleteBody', { name: entryTitle(preview) }),
                        confirmLabel: t('media.delete'),
                        cancelLabel: t('sidebar.cancel'),
                        destructive: true,
                      })
                      if (!ok) return
                      await removeOne(preview.id)
                      setPreview(null)
                    }}
                    style={[s.previewAction, { borderColor: 'rgba(255,255,255,0.2)' }]}
                  >
                    <Trash2 size={15} color={tokens.destructive} />
                    <Text style={[s.previewActionText, { color: tokens.destructive }]}>{t('media.delete')}</Text>
                  </Pressable>
                </View>
              </View>
            </>
          )}
        </View>
      </Modal>

      {/* Fullscreen with zoom (same viewer as the chat) — only the image has something
          to zoom; page, video and audio already fill the whole preview. */}
      {preview?.url && kindOf(preview) === 'image' && (
        <ImageLightbox src={preview.url} alt={preview.name} open={fullscreen} onOpenChange={setFullscreen} />
      )}
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '600' },

  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  searchBox: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, paddingHorizontal: 10, height: 38 },
  searchInput: { flex: 1, fontSize: 13, height: '100%' },
  refreshBtn: { width: 38, height: 38, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },

  filtersWrap: { paddingTop: 10 },
  filtersContent: { paddingHorizontal: 16, gap: 6, alignItems: 'center' },
  filtersDivider: { width: 1, height: 18, marginHorizontal: 4 },
  chip: { borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  chipText: { fontSize: 12, fontWeight: '500' },

  selectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginTop: 10,
    padding: 6,
    borderRadius: 10,
  },
  selectionCount: { flex: 1, fontSize: 13, fontWeight: '500', marginLeft: 4 },
  deleteBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  deleteBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  cancelBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  emptyText: { fontSize: 13 },

  gridContent: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 16 },
  gridRow: { gap: 10, marginBottom: 10 },
  thumb: {
    flex: 1,
    aspectRatio: 16 / 9,
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
  },
  thumbImg: { flex: 1 },
  thumbEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  /** Tile card for what is not an image: icon + type + title. */
  cardBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 10 },
  cardKind: { fontSize: 9, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase' },
  cardTitle: { fontSize: 11, fontWeight: '500', textAlign: 'center' },
  thumbLabelWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 6,
    paddingVertical: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  thumbLabel: { color: '#fff', fontSize: 10, fontWeight: '500' },
  checkBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1 },
  footerText: { fontSize: 11 },

  previewWrap: { flex: 1 },
  previewClose: {
    position: 'absolute',
    top: 8,
    right: 12,
    zIndex: 2,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewViewer: { flex: 1, overflow: 'hidden' },
  previewImgWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  previewImg: { width: '100%', height: '100%' },
  mediaFill: { flex: 1 },
  pageViewer: { flex: 1, backgroundColor: 'transparent' },
  pageLoading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  audioWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  audioTitle: { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center', paddingHorizontal: 24 },
  audioPlay: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioTime: { color: 'rgba(255,255,255,0.65)', fontSize: 12 },
  expandBadge: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewMeta: { paddingHorizontal: 20, paddingTop: 12 },
  previewName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  previewSub: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 4 },
  previewActions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  previewAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  previewActionText: { color: '#fff', fontSize: 13, fontWeight: '500' },
})
