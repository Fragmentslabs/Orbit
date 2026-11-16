import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Image } from 'expo-image'
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ChevronDown, ChevronUp, Pencil, Save, Search, X } from 'lucide-react-native'
import type { FilesReadResponse } from '@orbit/shared'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { useTokens } from '~/components/list/parts'
import { AssistantMarkdown } from '~/components/chat/AssistantMarkdown'
import { CodeViewer, type CodeViewerHandle } from '~/components/files/CodeViewer'
import { CodeEditor } from '~/components/files/CodeEditor'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { filesApi } from '~/lib/files-api'
import { baseName, categoryOf, findMatches, formatBytes, lineCount, lineOfOffset, stepIndex } from '~/lib/files'
import { useBottomBreathing } from '~/lib/keyboard'

type Mode = 'view' | 'edit'

/**
 * One file: highlighted viewer (with find), markdown preview, image, or the editor.
 * Edits save back through the desktop, which refuses the write if the file changed on disk
 * since this screen loaded it (so a concurrent desktop edit is never clobbered silently).
 */
export default function FileViewScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const navigation = useNavigation()
  const confirm = useConfirm()
  const tokens = useTokens()
  const breathing = useBottomBreathing()
  const params = useLocalSearchParams<{ sessionId: string; root?: string; path: string }>()
  const scope = useMemo(() => ({ sessionId: params.sessionId, root: params.root || undefined }), [params.sessionId, params.root])
  const path = params.path

  const [file, setFile] = useState<FilesReadResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('view')
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [markdownSource, setMarkdownSource] = useState(false)

  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState(0)
  const viewer = useRef<CodeViewerHandle>(null)

  const [reload, setReload] = useState(0)
  const load = () => setReload((n) => n + 1)

  useEffect(() => {
    let alive = true
    filesApi
      .read(scope, path)
      .then((res) => {
        if (!alive) return
        setFile(res)
        setDraft(res.content ?? '')
        setError(null)
      })
      .catch((err: Error) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [scope, path, reload])

  const original = file?.content ?? ''
  const dirty = mode === 'edit' && draft !== original
  const isText = file?.kind === 'text'
  const name = baseName(path)
  const isMarkdown = categoryOf(name) === 'markdown'

  const askDiscard = useCallback(
    () =>
      confirm({
        title: t('filesBrowser.unsavedTitle'),
        description: t('filesBrowser.unsavedBody'),
        confirmLabel: t('filesBrowser.unsavedDiscard'),
        cancelLabel: t('filesBrowser.unsavedKeep'),
        destructive: true,
      }),
    [confirm, t],
  )

  // Dirty guard: back gesture, header button and Android back all end in `beforeRemove`.
  useEffect(() => {
    return navigation.addListener('beforeRemove', (e) => {
      if (!dirty) return
      e.preventDefault()
      void askDiscard().then((discard) => {
        if (discard) navigation.dispatch(e.data.action)
      })
    })
  }, [dirty, navigation, askDiscard])

  const matches = useMemo(() => (findOpen && isText ? findMatches(original, query) : []), [findOpen, isText, original, query])
  useEffect(() => {
    if (matches.length && matches[current] !== undefined) {
      viewer.current?.scrollToLine(lineOfOffset(original, matches[current]))
    }
  }, [current, matches, original])

  const save = async (force = false): Promise<void> => {
    {
      if (!file) return
      setSaving(true)
      setError(null)
      try {
        const res = await filesApi.write(scope, path, draft, force ? undefined : file.mtimeMs)
        if (res.ok) {
          setFile({ ...file, content: draft, mtimeMs: res.mtimeMs, size: res.size })
          setJustSaved(true)
          setTimeout(() => setJustSaved(false), 1500)
          setMode('view')
          return
        }
        if (res.reason === 'stale') {
          const overwrite = await confirm({
            title: t('filesBrowser.staleTitle'),
            description: t('filesBrowser.staleBody'),
            confirmLabel: t('filesBrowser.staleOverwrite'),
            cancelLabel: t('filesBrowser.staleReload'),
            destructive: true,
          })
          if (overwrite) await save(true)
          else if (res.content !== undefined && res.mtimeMs !== undefined) {
            setFile({ ...file, content: res.content, mtimeMs: res.mtimeMs })
            setDraft(res.content)
          }
          return
        }
        setError(t('filesBrowser.saveFailed', { reason: t(`filesBrowser.reason.${res.reason}`) }))
      } catch (err) {
        setError(t('filesBrowser.saveFailed', { reason: (err as Error).message }))
      } finally {
        setSaving(false)
      }
    }
  }

  const discard = async () => {
    if (dirty && !(await askDiscard())) return
    setDraft(original)
    setMode('view')
  }

  const showMarkdown = isMarkdown && isText && !markdownSource && mode === 'view'

  return (
    <SafeScreen>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.iconBtn} hitSlop={4}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: tokens.foreground }}>
            {dirty ? `● ${name}` : name}
          </Text>
          {file ? (
            <Text numberOfLines={1} style={{ fontSize: 11.5, color: tokens.mutedForeground }}>
              {justSaved
                ? t('filesBrowser.saved')
                : isText
                  ? `${t('filesBrowser.lines', { count: lineCount(mode === 'edit' ? draft : original) })} · ${formatBytes(file.size)}`
                  : formatBytes(file.size)}
            </Text>
          ) : null}
        </View>
        {isText && mode === 'view' && (
          <>
            {isMarkdown && (
              <Pressable onPress={() => setMarkdownSource((v) => !v)} style={[s.pill, { borderColor: tokens.border }]}>
                <Text style={{ fontSize: 12.5, color: tokens.foreground }}>
                  {markdownSource ? t('filesBrowser.preview') : t('filesBrowser.source')}
                </Text>
              </Pressable>
            )}
            {!showMarkdown && (
              <Pressable onPress={() => setFindOpen((v) => !v)} style={s.iconBtn} accessibilityLabel={t('filesBrowser.find')}>
                <Search size={20} color={tokens.foreground} />
              </Pressable>
            )}
            <Pressable onPress={() => { setFindOpen(false); setMode('edit') }} style={s.iconBtn} accessibilityLabel={t('filesBrowser.edit')}>
              <Pencil size={20} color={tokens.foreground} />
            </Pressable>
          </>
        )}
        {mode === 'edit' && (
          <>
            <Pressable onPress={() => void discard()} style={[s.pill, { borderColor: tokens.border }]}>
              <Text style={{ fontSize: 12.5, color: tokens.foreground }}>{t('filesBrowser.discard')}</Text>
            </Pressable>
            <Pressable
              onPress={() => void save()}
              disabled={!dirty || saving}
              style={[s.pill, { borderColor: 'transparent', backgroundColor: tokens.primary, opacity: !dirty || saving ? 0.45 : 1 }]}
            >
              {saving ? <ActivityIndicator size="small" color={tokens.primaryForeground} /> : <Save size={14} color={tokens.primaryForeground} />}
              <Text style={{ fontSize: 12.5, fontWeight: '600', color: tokens.primaryForeground }}>{t('filesBrowser.save')}</Text>
            </Pressable>
          </>
        )}
      </View>

      {findOpen && mode === 'view' && isText && !showMarkdown && (
        <View style={[s.findBar, { borderBottomColor: tokens.border, backgroundColor: tokens.card }]}>
          <TextInput
            value={query}
            onChangeText={(v) => { setQuery(v); setCurrent(0) }}
            placeholder={t('filesBrowser.findPlaceholder')}
            placeholderTextColor={tokens.mutedForeground}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            style={{ flex: 1, fontSize: 14, color: tokens.foreground, paddingVertical: 6 }}
          />
          <Text style={{ fontSize: 12, color: tokens.mutedForeground }}>
            {query ? (matches.length ? t('filesBrowser.findCount', { current: current + 1, total: matches.length }) : t('filesBrowser.findNone')) : ''}
          </Text>
          <Pressable onPress={() => setCurrent((c) => stepIndex(c, matches.length, -1))} style={s.smallBtn} accessibilityLabel={t('filesBrowser.findPrev')}>
            <ChevronUp size={18} color={tokens.foreground} />
          </Pressable>
          <Pressable onPress={() => setCurrent((c) => stepIndex(c, matches.length, 1))} style={s.smallBtn} accessibilityLabel={t('filesBrowser.findNext')}>
            <ChevronDown size={18} color={tokens.foreground} />
          </Pressable>
          <Pressable onPress={() => { setFindOpen(false); setQuery('') }} style={s.smallBtn} accessibilityLabel={t('filesBrowser.close')}>
            <X size={18} color={tokens.foreground} />
          </Pressable>
        </View>
      )}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={-breathing}>
        {error && !file ? (
          <View style={s.center}>
            <Text style={{ color: tokens.destructive, textAlign: 'center', paddingHorizontal: 24 }}>
              {t('filesBrowser.loadFailed', { error })}
            </Text>
            <Pressable onPress={load} style={[s.pill, { borderColor: tokens.border }]}>
              <Text style={{ color: tokens.foreground }}>{t('filesBrowser.retry')}</Text>
            </Pressable>
          </View>
        ) : !file ? (
          <View style={s.center}>
            <ActivityIndicator color={tokens.mutedForeground} />
          </View>
        ) : file.kind === 'image' && file.url ? (
          <ScrollView maximumZoomScale={4} minimumZoomScale={1} contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Image source={{ uri: file.url }} style={{ width: '100%', height: '100%', minHeight: 320 }} contentFit="contain" />
          </ScrollView>
        ) : file.kind === 'binary' || file.kind === 'too-large' ? (
          <View style={s.center}>
            <Text style={{ color: tokens.mutedForeground, textAlign: 'center', paddingHorizontal: 24 }}>
              {file.kind === 'binary' ? t('filesBrowser.binary') : t('filesBrowser.tooLarge', { size: formatBytes(file.size) })}
            </Text>
          </View>
        ) : mode === 'edit' ? (
          <CodeEditor value={draft} onChange={setDraft} autoFocus />
        ) : showMarkdown ? (
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
            <AssistantMarkdown text={original} />
          </ScrollView>
        ) : (
          <CodeViewer
            ref={viewer}
            content={original}
            fileName={name}
            matches={matches}
            matchLength={query.length}
            currentMatch={current}
          />
        )}
        {error && file ? (
          <Text style={{ color: tokens.destructive, fontSize: 12.5, padding: 10, textAlign: 'center' }}>{error}</Text>
        ) : null}
      </KeyboardAvoidingView>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, marginRight: 4 },
  findBar: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 14, paddingRight: 4, borderBottomWidth: 1 },
  smallBtn: { width: 36, height: 40, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
})
