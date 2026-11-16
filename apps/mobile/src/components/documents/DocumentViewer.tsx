/**
 * The document viewer: a full-screen layer over the chat (the equivalent of the desktop's document
 * panel), in the style of PieceViewer. Header (close, title, share), optional find bar, the page in
 * a WebView, outline overlay and a bar with outline / find / zoom.
 *
 * It shows two things through the same chrome:
 * - a document the agent wrote: the desktop's own HTML preview (`previewSrc`) — what is seen is
 *   what the PDF/DOCX export is built from;
 * - a cited source (`#orbit-source/...`): the desktop reads its text (`GET /api/documents/:id/text`)
 *   and the phone draws the numbered lines with the cited ones marked; a .docx opened without a
 *   citation uses the converted HTML instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronUp,
  List,
  Minus,
  Plus,
  Search,
  Share2,
  X,
} from 'lucide-react-native'
import type { DocumentTextView } from '@orbit/companion-client'

import { PieceView } from '~/components/chat/PieceView'
import { StageLoading, BarButton, ViewerBar } from '~/components/chat/pieces/viewers/kit'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { buildSourceHtml, sourceToText, wrapDocxHtml } from '~/lib/document-source'
import {
  CLEAR_FIND_SCRIPT,
  DOC_SCRIPT,
  findScript,
  jumpScript,
  parseDocMessage,
  stepScript,
  stepZoom,
  zoomScript,
  type OutlineEntry,
} from '~/lib/document-web-script'
import { shareFileName, shareRemoteFile, shareText } from '~/lib/document-share'
import { useConnectionStore } from '~/stores/connection-store'
import { useThemeStore } from '~/stores/theme-store'
import type { DocumentTarget } from '~/stores/document-viewer-store'

type SourceState =
  | { status: 'loading' }
  | { status: 'error'; notFound: boolean }
  | { status: 'ready'; view: DocumentTextView; docxHtml?: string }

/** Loads a cited source through the companion. */
function useSource(target: DocumentTarget): SourceState {
  const http = useConnectionStore((s) => s.http)
  const [state, setState] = useState<SourceState>({ status: 'loading' })
  const docId = target.kind === 'source' ? target.docId : null
  const sessionId = target.kind === 'source' ? target.sessionId : undefined
  const cited = target.kind === 'source' && target.fromLine !== undefined

  useEffect(() => {
    if (!docId) return
    let alive = true
    void (async () => {
      if (!http) return alive && setState({ status: 'error', notFound: false })
      const res = await http.getDocumentText(docId, sessionId)
      if (!alive) return
      if (!res.ok || !res.data) {
        return setState({ status: 'error', notFound: String(res.error ?? '').startsWith('404') })
      }
      const view = res.data
      // An uncited .docx reads best as the document; a citation needs the numbered lines.
      if (view.originalKind === 'docx' && !cited) {
        const html = await http.getDocumentHtml(docId, sessionId)
        if (!alive) return
        if (html.ok && html.data?.html) return setState({ status: 'ready', view, docxHtml: html.data.html })
      }
      setState({ status: 'ready', view })
    })()
    return () => {
      alive = false
    }
  }, [http, docId, sessionId, cited])

  return state
}

export function DocumentViewer({ target, onClose }: { target: DocumentTarget; onClose: () => void }) {
  const { t } = useTranslation()
  const resolved = useThemeStore((s) => s.resolved)
  const tokens = getThemeTokens(resolved)
  const insets = useSafeAreaInsets()

  // Same trick as PieceViewer: the sheet slides in empty, the WebView is born after.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 450)
    return () => clearTimeout(timer)
  }, [])

  const source = useSource(target)
  const injectRef = useRef<((js: string) => void) | null>(null)
  const [outline, setOutline] = useState<OutlineEntry[]>([])
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [find, setFind] = useState({ count: 0, index: -1 })
  const [zoom, setZoom] = useState(1)
  const [shareError, setShareError] = useState(false)

  const colors = useMemo(
    () => ({
      background: tokens.background,
      foreground: tokens.foreground,
      muted: tokens.mutedForeground,
      border: tokens.border,
      accent: tokens.primary,
      highlight: withAlpha(tokens.primary, 0.22),
    }),
    [tokens],
  )

  const sourceHtml = useMemo(() => {
    if (target.kind !== 'source' || source.status !== 'ready') return undefined
    if (source.docxHtml) return wrapDocxHtml(source.docxHtml, colors)
    return buildSourceHtml(source.view, {
      cite: target.fromLine !== undefined ? { page: target.page, fromLine: target.fromLine, toLine: target.toLine } : undefined,
      colors,
      pageTitle: (page, kind) =>
        page.label
          ? t('docViewer.sheet', { name: page.label })
          : kind === 'docx'
            ? t('docViewer.block', { n: page.num })
            : t('docViewer.page', { n: page.num }),
    })
  }, [target, source, colors, t])

  const title =
    target.kind === 'part'
      ? target.title || t('docViewer.title')
      : source.status === 'ready'
        ? source.view.filename
        : target.docId
  const badge =
    target.kind === 'part'
      ? t('docViewer.kind.document')
      : source.status === 'ready'
        ? t(`docViewer.kind.${source.view.kind}`)
        : null

  const run = useCallback((js: string) => injectRef.current?.(js), [])

  const onReady = useCallback((inject: (js: string) => void) => {
    injectRef.current = inject
    setOutline([])
    inject(DOC_SCRIPT)
  }, [])

  const onMessage = useCallback((data: string) => {
    const msg = parseDocMessage(data)
    if (!msg) return
    if (msg.type === 'outline') setOutline(msg.items)
    else setFind({ count: msg.count, index: msg.index })
  }, [])

  const changeZoom = (direction: 1 | -1) => {
    const next = stepZoom(zoom, direction)
    setZoom(next)
    run(zoomScript(next))
  }

  const closeFind = () => {
    setFindOpen(false)
    setQuery('')
    run(CLEAR_FIND_SCRIPT)
  }

  const share = async () => {
    setShareError(false)
    try {
      if (target.kind === 'part') {
        await shareRemoteFile(
          target.src,
          shareFileName(target.title, target.documentId, 'html'),
          'text/html',
          title,
        )
      } else if (source.status === 'ready') {
        await shareText(sourceToText(source.view), shareFileName(source.view.filename, target.docId, 'txt'), title)
      }
    } catch {
      setShareError(true)
    }
  }

  const canShare = target.kind === 'part' || source.status === 'ready'
  const loading = !mounted || (target.kind === 'source' && source.status === 'loading')
  const citeLabel =
    target.kind === 'source' && target.fromLine !== undefined
      ? target.toLine && target.toLine > target.fromLine
        ? t('docViewer.citedLines', { from: target.fromLine, to: target.toLine })
        : t('docViewer.citedLine', { n: target.fromLine })
      : null

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View
        testID="document-viewer"
        className="flex-1"
        style={{ backgroundColor: tokens.background, paddingTop: insets.top }}
      >
        <View className="flex-row items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: tokens.border }}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t('docViewer.close')}
            hitSlop={10}
            className="h-8 w-8 items-center justify-center rounded-full"
            style={{ backgroundColor: tokens.muted }}
          >
            <X size={16} color={tokens.foreground} />
          </Pressable>
          <View className="flex-1">
            <Text numberOfLines={1} className="text-sm font-medium" style={{ color: tokens.foreground }}>
              {title}
            </Text>
            {citeLabel ? (
              <Text numberOfLines={1} className="text-[10px]" style={{ color: tokens.mutedForeground }}>
                {t('docViewer.page', { n: target.kind === 'source' ? target.page : 0 })} · {citeLabel}
              </Text>
            ) : null}
          </View>
          {badge ? (
            <View className="rounded px-1.5 py-[1px]" style={{ backgroundColor: tokens.muted }}>
              <Text className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: tokens.mutedForeground }}>
                {badge}
              </Text>
            </View>
          ) : null}
          <Pressable
            onPress={share}
            disabled={!canShare}
            accessibilityRole="button"
            accessibilityLabel={t('docViewer.share')}
            hitSlop={10}
            className="h-8 w-8 items-center justify-center rounded-full"
            style={{ backgroundColor: tokens.muted, opacity: canShare ? 1 : 0.4 }}
          >
            <Share2 size={15} color={tokens.foreground} />
          </Pressable>
        </View>

        {findOpen ? (
          <View className="flex-row items-center gap-2 border-b px-3 py-2" style={{ borderColor: tokens.border }}>
            <TextInput
              autoFocus
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={() => run(findScript(query))}
              onEndEditing={() => run(findScript(query))}
              returnKeyType="search"
              placeholder={t('docViewer.findPlaceholder')}
              placeholderTextColor={tokens.mutedForeground}
              accessibilityLabel={t('docViewer.find')}
              className="h-8 flex-1 rounded-md px-2 text-sm"
              style={{ backgroundColor: tokens.muted, color: tokens.foreground }}
            />
            <Text className="min-w-[44px] text-center text-[11px]" style={{ color: tokens.mutedForeground }}>
              {find.count > 0
                ? `${find.index + 1}/${find.count}`
                : query.trim().length >= 2
                  ? t('docViewer.findNone')
                  : ''}
            </Text>
            <Pressable
              onPress={() => run(stepScript(-1))}
              disabled={find.count === 0}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('docViewer.findPrev')}
              style={{ opacity: find.count === 0 ? 0.4 : 1 }}
            >
              <ChevronUp size={18} color={tokens.foreground} />
            </Pressable>
            <Pressable
              onPress={() => run(stepScript(1))}
              disabled={find.count === 0}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('docViewer.findNext')}
              style={{ opacity: find.count === 0 ? 0.4 : 1 }}
            >
              <ChevronDown size={18} color={tokens.foreground} />
            </Pressable>
            <Pressable onPress={closeFind} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('docViewer.findClose')}>
              <X size={16} color={tokens.mutedForeground} />
            </Pressable>
          </View>
        ) : null}

        <View className="flex-1">
          {!loading && target.kind === 'part' ? (
            <PieceView
              bare
              src={target.src}
              revision={target.revision}
              title={title}
              onReady={onReady}
              onMessage={onMessage}
              loadingLabel={t('docViewer.loading')}
              errorLabel={t('docViewer.error')}
            />
          ) : null}
          {!loading && target.kind === 'source' && sourceHtml ? (
            <PieceView
              bare
              html={sourceHtml}
              title={title}
              onReady={onReady}
              onMessage={onMessage}
              loadingLabel={t('docViewer.loading')}
              errorLabel={t('docViewer.error')}
            />
          ) : null}
          {target.kind === 'source' && source.status === 'error' ? (
            <View className="flex-1 items-center justify-center px-8">
              <Text className="text-center text-sm" style={{ color: tokens.mutedForeground }}>
                {source.notFound ? t('docViewer.notFound') : t('docViewer.error')}
              </Text>
            </View>
          ) : null}
          {loading ? <StageLoading label={t('docViewer.loading')} /> : null}

          {outlineOpen ? (
            <View
              testID="document-outline"
              className="absolute inset-0"
              style={{ backgroundColor: tokens.background }}
            >
              <ScrollView contentContainerStyle={{ padding: 12 }}>
                {outline.length === 0 ? (
                  <Text className="py-6 text-center text-sm" style={{ color: tokens.mutedForeground }}>
                    {t('docViewer.outlineEmpty')}
                  </Text>
                ) : (
                  outline.map((item) => (
                    <Pressable
                      key={item.id}
                      onPress={() => {
                        setOutlineOpen(false)
                        run(jumpScript(item.id))
                      }}
                      accessibilityRole="button"
                      className="py-2"
                      style={{ paddingLeft: Math.min(item.level - 1, 4) * 14 }}
                    >
                      <Text
                        numberOfLines={2}
                        className={item.level <= 2 ? 'text-sm font-medium' : 'text-[13px]'}
                        style={{ color: tokens.foreground }}
                      >
                        {item.title}
                      </Text>
                    </Pressable>
                  ))
                )}
              </ScrollView>
            </View>
          ) : null}
        </View>

        {shareError ? (
          <Text className="px-3 py-1 text-center text-[11px]" style={{ color: tokens.destructive }}>
            {t('docViewer.shareFailed')}
          </Text>
        ) : null}

        <ViewerBar>
          <BarButton
            icon={List}
            label={t('docViewer.outline')}
            onPress={() => setOutlineOpen((v) => !v)}
            active={outlineOpen}
            testID="document-outline-button"
          />
          <BarButton
            icon={Search}
            label={t('docViewer.find')}
            onPress={() => (findOpen ? closeFind() : setFindOpen(true))}
            active={findOpen}
            testID="document-find-button"
          />
          <View className="flex-1" />
          <BarButton icon={Minus} label={t('docViewer.zoomOut')} onPress={() => changeZoom(-1)} />
          <Text className="w-10 text-center text-xs" style={{ color: tokens.mutedForeground }}>
            {Math.round(zoom * 100)}%
          </Text>
          <BarButton icon={Plus} label={t('docViewer.zoomIn')} onPress={() => changeZoom(1)} />
        </ViewerBar>
      </View>
    </Modal>
  )
}
