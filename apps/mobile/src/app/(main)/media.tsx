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
} from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { MediaEntry, MediaSource } from '@orbit/shared'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useConnectionStore } from '~/stores/connection-store'
import { useSessionStore } from '~/stores/session-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useMediaStore } from '~/stores/media-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { ImageLightbox } from '~/components/chat/ImageLightbox'

type SourceFilter = 'all' | MediaSource
type PeriodFilter = 'all' | 'today' | 'week' | 'month'

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

export default function MediaScreen() {
  const { t, i18n } = useTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const mode = useWorkspaceStore((s) => s.mode)
  const setMode = useWorkspaceStore((s) => s.setMode)
  const sessions = useSessionStore((s) => s.sessions)
  const http = useConnectionStore((s) => s.http)

  const entries = useMediaStore((s) => s.entries)
  const usage = useMediaStore((s) => s.usage)
  const loading = useMediaStore((s) => s.loading)
  const refreshing = useMediaStore((s) => s.refreshing)
  const refresh = useMediaStore((s) => s.refresh)
  const remove = useMediaStore((s) => s.remove)
  const removeOne = useMediaStore((s) => s.removeOne)

  const [query, setQuery] = useState('')
  const [source, setSource] = useState<SourceFilter>('all')
  const [period, setPeriod] = useState<PeriodFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectionMode, setSelectionMode] = useState(false)
  const [preview, setPreview] = useState<MediaEntry | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  // Referência de tempo para o filtro de período, atualizada a cada refresh —
  // evita chamar Date.now() durante o render (react-hooks/purity).
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (http) void refresh()
  }, [http, refresh])

  const handleRefresh = useCallback(() => {
    setNow(Date.now())
    void refresh()
  }, [refresh])

  /** Sessões do modo atual — escopo da galeria (chat mostra só chat, etc). */
  const modeSessionIds = useMemo(
    () => new Set(sessions.filter((s) => s.mode === mode).map((s) => s.id)),
    [sessions, mode],
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const since = period === 'all' ? 0 : now - PERIOD_MS[period]
    return entries.filter((entry) => {
      if (source !== 'all' && entry.source !== source) return false
      // Órfãs (sem sessão) aparecem nos dois modos; com sessão, só no modo dela.
      if (entry.sessionId && !modeSessionIds.has(entry.sessionId)) return false
      if (entry.createdAt < since) return false
      if (!needle) return true
      return `${entry.name ?? ''} ${entry.taskId ?? ''} ${entry.id}`.toLowerCase().includes(needle)
    })
  }, [entries, source, period, query, modeSessionIds, now])

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
    await remove(ids)
    exitSelection()
    setPreview((current) => (current && ids.includes(current.id) ? null : current))
  }, [selected, remove, exitSelection])

  /** Abre o chat de origem da imagem, trocando o modo se necessário. */
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
    return (
      <Pressable
        onPress={() => (selecting ? toggle(item.id) : setPreview(item))}
        onLongPress={() => {
          if (!selecting) enterSelection(item.id)
          else toggle(item.id)
        }}
        style={[s.thumb, { borderColor: isSelected ? tokens.primary : tokens.border, backgroundColor: tokens.muted }]}
      >
        {item.url ? (
          <Image source={item.url} style={s.thumbImg} contentFit="cover" transition={150} />
        ) : (
          <View style={s.thumbEmpty}>
            <ImageOff size={18} color={tokens.mutedForeground} />
          </View>
        )}
        {item.name ? (
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

      {/* Busca + refresh */}
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

      {/* Filtros — origem e período, com divisor como no desktop */}
      <View style={s.filtersWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filtersContent}>
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

      {/* Barra de seleção */}
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

      {/* Rodapé de uso */}
      <View style={[s.footer, { borderTopColor: tokens.border }]}>
        <HardDrive size={13} color={tokens.mutedForeground} />
        <Text style={[s.footerText, { color: tokens.mutedForeground }]}>
          {t('media.usage', { count: usage.count, size: formatBytes(usage.bytes) })}
        </Text>
      </View>

      {/* Preview (detalhe + ações) */}
      <Modal visible={!!preview} transparent animationType="fade" onRequestClose={() => setPreview(null)} statusBarTranslucent>
        <View style={[s.previewWrap, { backgroundColor: 'rgba(0,0,0,0.92)' }]}>
          <View style={{ height: insets.top }} />
          <Pressable onPress={() => setPreview(null)} style={s.previewClose}>
            <X size={22} color="#fff" />
          </Pressable>
          {preview && (
            <>
              <Pressable style={s.previewImgWrap} onPress={() => setFullscreen(true)}>
                {preview.url && (
                  <Image source={preview.url} style={s.previewImg} contentFit="contain" />
                )}
                <View style={s.expandBadge}>
                  <Maximize2 size={14} color="#fff" />
                </View>
              </Pressable>
              <View style={[s.previewMeta, { paddingBottom: insets.bottom + 12 }]}>
                <Text style={s.previewName} numberOfLines={1}>{preview.name || preview.id}</Text>
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
                      await removeOne(preview.id)
                      setPreview(null)
                    }}
                    style={[s.previewAction, { borderColor: 'rgba(255,255,255,0.2)' }]}
                  >
                    <Trash2 size={15} color="#ff6b6b" />
                    <Text style={[s.previewActionText, { color: '#ff6b6b' }]}>{t('media.delete')}</Text>
                  </Pressable>
                </View>
              </View>
            </>
          )}
        </View>
      </Modal>

      {/* Fullscreen com zoom (mesmo viewer do chat) */}
      {preview?.url && (
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
  previewImgWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  previewImg: { width: '100%', height: '100%' },
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
