/**
 * Sources screen — mirror of the desktop Sources tab: the documents the conversation reads
 * (`docN` attachments of this chat, `srcN` sources of its folder). The desktop is the source
 * of truth; this screen lists, adds (file / pasted text / website), moves between the two
 * areas and removes through the companion (`/api/sources/*`), and refetches on WS
 * `sources:changed`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, TextInput, ScrollView, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system/legacy'
import * as Clipboard from 'expo-clipboard'
import {
  ArrowDownToLine, ArrowUpToLine, FileCode2, FileSpreadsheet, FileText, FileType2, Globe,
  Library, MessageSquare, FolderOpen, Plus, StickyNote, Trash2, Upload, ClipboardPaste, TriangleAlert,
} from 'lucide-react-native'
import type { LucideIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { CompanionSource } from '@orbit/shared'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { ListHeader, HeaderButton, ListRow, SectionLabel, CountLine, useTokens } from '~/components/list/parts'
import { ActionMenu } from '~/components/ui/action-menu'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { useConnectionStore } from '~/stores/connection-store'
import { useSessionStore } from '~/stores/session-store'
import { useSourcesStore } from '~/stores/sources-store'
import { DRAFT_SCOPE, MAX_SOURCE_BYTES, formatBytes, hostOf, normalizeSourceUrl, sortSources, sourceTypeLabel, sourceUnitKey } from '~/lib/sources'

const KIND_ICON: Record<CompanionSource['kind'], LucideIcon> = {
  pdf: FileText, docx: FileType2, spreadsheet: FileSpreadsheet, text: StickyNote, web: Globe,
}

function iconOf(source: CompanionSource): LucideIcon {
  return source.kind === 'text' && /\.(md|markdown|mdx)$/i.test(source.filename) ? FileCode2 : KIND_ICON[source.kind]
}

export default function SourcesScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = useTokens()
  const confirm = useConfirm()
  const { sessionId } = useLocalSearchParams<{ sessionId?: string }>()
  const scope = sessionId || DRAFT_SCOPE
  const http = useConnectionStore((s) => s.http)
  const list = useSourcesStore((s) => s.list)
  const loading = useSourcesStore((s) => s.loading)
  const error = useSourcesStore((s) => s.error)
  const refresh = useSourcesStore((s) => s.refresh)
  const sessionTitle = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.title)

  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [addMenu, setAddMenu] = useState(false)
  const [rowMenu, setRowMenu] = useState<CompanionSource | null>(null)
  const [dialog, setDialog] = useState<'text' | 'url' | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  /** Where NEW sources go — only meaningful when the chat has a folder. */
  const [toFolder, setToFolder] = useState(false)

  useEffect(() => {
    void refresh(scope)
  }, [scope, refresh])

  const folderId = list?.folderId ?? null
  const shared = useMemo(() => sortSources(list?.shared ?? []), [list])
  const own = useMemo(() => sortSources(list?.own ?? []), [list])
  const target = toFolder && folderId !== null

  /** Runs one companion call: busy flag, error banner, and a refetch either way. */
  const run = useCallback(
    async (call: () => Promise<{ ok: boolean; error?: string }>) => {
      setBusy(true)
      setMessage(null)
      try {
        const res = await call()
        if (!res.ok) setMessage(res.error ?? t('sources.failed'))
      } finally {
        setBusy(false)
        await refresh(scope)
      }
    },
    [refresh, scope, t],
  )

  const pickFile = useCallback(async () => {
    if (!http) return
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true })
    if (picked.canceled) return
    for (const asset of picked.assets) {
      if (asset.size && asset.size > MAX_SOURCE_BYTES) {
        setMessage(t('sources.tooBig', { name: asset.name, size: formatBytes(MAX_SOURCE_BYTES) }))
        continue
      }
      await run(async () => {
        const data = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 })
        return http.addSourceFile(scope, asset.name, data, target)
      })
    }
  }, [http, run, scope, t, target])

  const closeDialog = () => {
    setDialog(null)
    setTitle('')
    setBody('')
  }

  const submitDialog = useCallback(async () => {
    if (!http || !dialog) return
    if (dialog === 'url') {
      const url = normalizeSourceUrl(body)
      if (!url) {
        setMessage(t('sources.invalidUrl'))
        return
      }
      closeDialog()
      await run(() => http.addSourceUrl(scope, url, target))
    } else {
      if (!body.trim()) return
      const name = title
      const text = body
      closeDialog()
      await run(() => http.addSourceText(scope, name, text, target))
    }
  }, [http, dialog, body, title, scope, target, run, t])

  const pasteIntoBody = async () => {
    const text = await Clipboard.getStringAsync()
    if (text) setBody(text)
  }

  const move = (source: CompanionSource) => {
    if (!http) return
    void run(() => http.setSourceShared(scope, source.id, !source.shared))
  }

  const remove = async (source: CompanionSource) => {
    if (!http) return
    const ok = await confirm({
      title: t('sources.removeTitle'),
      description: t('sources.removeBody', { name: source.filename }),
      confirmLabel: t('sources.remove'),
      cancelLabel: t('sources.cancel'),
      destructive: true,
    })
    if (ok) void run(() => http.removeSource(scope, source.id))
  }

  const renderRow = (source: CompanionSource) => {
    const Icon = iconOf(source)
    const type = sourceTypeLabel(source) ?? t(`sources.kind.${source.kind}`)
    const meta = [
      type,
      `${source.id} · ${t(`sources.${sourceUnitKey(source.kind)}`, { count: source.totalPages })}`,
      source.sourceUrl ? hostOf(source.sourceUrl) : null,
      source.sizeBytes ? formatBytes(source.sizeBytes) : null,
    ].filter(Boolean).join(' · ')
    return (
      <ListRow
        key={source.id}
        tile={
          <View style={[s.tile, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
            <Icon size={18} color={tokens.mutedForeground} />
          </View>
        }
        title={source.filename}
        lines={[
          { text: meta, quiet: true },
          ...(source.truncated ? [{ text: t('sources.truncated'), bad: true }] : []),
        ]}
        right={source.truncated ? <TriangleAlert size={16} color="#f59e0b" /> : undefined}
        onPress={() => setRowMenu(source)}
      />
    )
  }

  const empty = list !== null && shared.length === 0 && own.length === 0

  return (
    <SafeScreen style={s.container}>
      <ListHeader
        title={t('sources.title')}
        subtitle={sessionTitle ?? (sessionId ? undefined : t('sources.newChat'))}
        onBack={() => router.back()}
        right={
          <View style={{ marginRight: 12 }}>
            <HeaderButton icon={Plus} label={t('sources.add')} onPress={() => setAddMenu(true)} />
          </View>
        }
      />

      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh(scope)} />}
      >
        {folderId !== null && (
          <View style={[s.targetRow, { borderColor: tokens.border }]}>
            <Text style={{ color: tokens.mutedForeground, fontSize: 12.5, flex: 1 }}>{t('sources.newGoTo')}</Text>
            {([false, true] as const).map((isFolder) => (
              <Pressable
                key={String(isFolder)}
                onPress={() => setToFolder(isFolder)}
                style={[s.chip, { borderColor: tokens.border }, toFolder === isFolder && { backgroundColor: tokens.muted }]}
              >
                {isFolder ? <FolderOpen size={14} color={tokens.foreground} /> : <MessageSquare size={14} color={tokens.foreground} />}
                <Text style={{ color: tokens.foreground, fontSize: 12.5 }}>
                  {isFolder ? t('sources.folderArea') : t('sources.conversationArea')}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {(busy || message || error) && (
          <View style={s.banner}>
            {busy && <ActivityIndicator size="small" color={tokens.mutedForeground} />}
            <Text style={{ flex: 1, fontSize: 12.5, color: message || error ? tokens.destructive : tokens.mutedForeground }}>
              {message ?? (error && list === null ? t('sources.loadFailed') : busy ? t('sources.working') : '')}
            </Text>
          </View>
        )}

        {list === null && loading && <ActivityIndicator style={{ marginTop: 40 }} color={tokens.mutedForeground} />}

        {empty && (
          <View style={s.empty}>
            <Library size={28} color={tokens.mutedForeground} />
            <Text style={{ color: tokens.foreground, fontWeight: '600', fontSize: 15 }}>{t('sources.emptyTitle')}</Text>
            <Text style={{ color: tokens.mutedForeground, textAlign: 'center', fontSize: 13 }}>{t('sources.emptyBody')}</Text>
          </View>
        )}

        {folderId !== null && shared.length > 0 && (
          <>
            <View style={s.section}><SectionLabel>{t('sources.folderSources')}</SectionLabel></View>
            {shared.map(renderRow)}
          </>
        )}
        {own.length > 0 && (
          <>
            <View style={s.section}><SectionLabel>{t('sources.fromConversation')}</SectionLabel></View>
            {own.map(renderRow)}
          </>
        )}
        {list && list.usage > 0 && (
          <View style={{ paddingHorizontal: 18, paddingTop: 12 }}>
            <CountLine>{t('sources.usage', { size: formatBytes(list.usage) })}</CountLine>
          </View>
        )}
      </ScrollView>

      <ActionMenu
        visible={addMenu}
        onClose={() => setAddMenu(false)}
        items={[
          { icon: Upload, label: t('sources.addFile'), onPress: () => void pickFile() },
          { icon: ClipboardPaste, label: t('sources.addText'), onPress: () => setDialog('text') },
          { icon: Globe, label: t('sources.addUrl'), onPress: () => setDialog('url') },
        ]}
      />

      <ActionMenu
        visible={rowMenu !== null}
        onClose={() => setRowMenu(null)}
        anchor={{ top: 120, right: 12 }}
        items={
          rowMenu
            ? [
                ...(folderId !== null
                  ? [{
                      icon: rowMenu.shared ? ArrowDownToLine : ArrowUpToLine,
                      label: rowMenu.shared ? t('sources.unshare') : t('sources.share'),
                      onPress: () => move(rowMenu),
                    }]
                  : []),
                { icon: Trash2, label: t('sources.remove'), destructive: true, onPress: () => void remove(rowMenu) },
              ]
            : []
        }
      />

      <BottomSheet
        open={dialog !== null}
        onClose={closeDialog}
        closeOnOutsideTap={false}
        title={dialog === 'url' ? t('sources.addUrl') : t('sources.addText')}
      >
        <View style={{ padding: 16, gap: 10 }}>
          {dialog === 'text' && (
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder={t('sources.titlePlaceholder')}
              placeholderTextColor={tokens.mutedForeground}
              style={[s.input, { borderColor: tokens.border, color: tokens.foreground }]}
            />
          )}
          <TextInput
            value={body}
            onChangeText={setBody}
            placeholder={dialog === 'url' ? t('sources.urlPlaceholder') : t('sources.textPlaceholder')}
            placeholderTextColor={tokens.mutedForeground}
            multiline={dialog === 'text'}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={dialog === 'url' ? 'url' : 'default'}
            style={[s.input, dialog === 'text' && { minHeight: 140, textAlignVertical: 'top' }, { borderColor: tokens.border, color: tokens.foreground }]}
          />
          <View style={s.actions}>
            {dialog === 'text' && (
              <Pressable onPress={() => void pasteIntoBody()} style={[s.btn, { borderColor: tokens.border }]}>
                <Text style={{ color: tokens.foreground }}>{t('sources.paste')}</Text>
              </Pressable>
            )}
            <View style={{ flex: 1 }} />
            <Pressable onPress={closeDialog} style={[s.btn, { borderColor: tokens.border }]}>
              <Text style={{ color: tokens.foreground }}>{t('sources.cancel')}</Text>
            </Pressable>
            <Pressable
              onPress={() => void submitDialog()}
              disabled={!body.trim()}
              style={[s.btn, { backgroundColor: tokens.primary, borderColor: tokens.primary, opacity: body.trim() ? 1 : 0.4 }]}
            >
              <Text style={{ color: tokens.primaryForeground }}>{t('sources.add')}</Text>
            </Pressable>
          </View>
        </View>
      </BottomSheet>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  tile: { width: 40, height: 40, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  section: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 4 },
  targetRow: { flexDirection: 'row', alignItems: 'center', gap: 8, margin: 16, marginBottom: 0 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, height: 32 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingTop: 10 },
  empty: { alignItems: 'center', gap: 8, padding: 40 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btn: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, height: 40, alignItems: 'center', justifyContent: 'center' },
})
