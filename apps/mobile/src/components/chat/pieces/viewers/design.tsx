/**
 * Design on the phone.
 *
 * The design `piece.url` is NOT a page: it is the `canvas.json` of the canvas, the
 * index the desktop writes in the folder of the piece (see
 * apps/desktop/electron/lib/design/design-canvas.ts):
 *
 *   { v: 1, title?, boards: { "<file>.html": { title?, x, y, w, h } }, order: string[] }
 *
 * Each artboard is a self-contained HTML in the SAME folder, and `order` is the sequence
 * of the screens (stacking, back to front) — the same one the screen bar of
 * the desktop uses. This viewer fetches that index, builds the list and opens one screen
 * at a time; the HTML of each one comes from the piece URL itself, swapping the
 * `canvas.json` at the end for the artboard file (the signed token is a segment
 * of the path and is valid for the whole folder, so the sibling inherits the authorization).
 *
 * The artboard is really interactive (it is a document, with its own scrolling, hover and
 * touch): nothing is drawn over it beyond the outer bars.
 */
import { AlertCircle, ChevronLeft, ChevronRight, Frame, RotateCw } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

import { PieceView } from '../../PieceView'

import type { PieceViewerProps } from './index'

/** One screen of the canvas: the `.html` file and the title it has in the index. */
export interface DesignScreen {
  file: string
  title?: string
}

/** Name of the index inside the canvas folder — the end of `piece.url`. */
const INDEX_FILE = 'canvas.json'

/**
 * Measurements of what is NOT the screen, so the WebView receives what is left of the window:
 * the bar of the shell (`PieceViewer`: a 32 button + padding + border), the inner bar
 * of `PieceView` with its margin, the row of arrows and the strip of
 * chips. Below that the screen does not fit and becomes a seal.
 */
const SHELL_HEADER = 54
const PIECE_CHROME = 41
const NAV_ROW = 44
const STRIP_ROW = 60
const MIN_VIEW_HEIGHT = 140

function isScreenFile(file: string): boolean {
  const segments = file.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function boardTitle(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const title = (value as { title?: unknown }).title
  return typeof title === 'string' && title.trim() ? title.trim() : undefined
}

function boardXy(value: unknown): { x: number; y: number } {
  const board = (value ?? {}) as { x?: unknown; y?: unknown }
  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0)
  return { x: num(board.x), y: num(board.y) }
}

/**
 * The `canvas.json` (already parsed) in the list of screens, or `[]`.
 *
 * `order` rules: it is the order the desktop shows, and the phone cannot number the
 * screens in a different order. The artboard that exists in `boards` but was left out of
 * `order` (a half-written index, written during generation) is still a screen —
 * it comes in at the end, in the reading order of the canvas (x, then y) —, otherwise a piece
 * with content would show up empty here.
 */
export function parseDesignCanvas(raw: unknown): DesignScreen[] {
  const canvas = (raw ?? {}) as { boards?: unknown; order?: unknown }
  const boards =
    canvas.boards && typeof canvas.boards === 'object' && !Array.isArray(canvas.boards)
      ? (canvas.boards as Record<string, unknown>)
      : {}

  const screens: DesignScreen[] = []
  const seen = new Set<string>()
  const push = (file: unknown) => {
    if (typeof file !== 'string' || !isScreenFile(file) || seen.has(file)) return
    if (!Object.prototype.hasOwnProperty.call(boards, file)) return
    seen.add(file)
    screens.push({ file, title: boardTitle(boards[file]) })
  }

  if (Array.isArray(canvas.order)) for (const file of canvas.order) push(file)

  const rest = Object.keys(boards).filter((file) => !seen.has(file) && isScreenFile(file))
  rest.sort((a, b) => {
    const left = boardXy(boards[a])
    const right = boardXy(boards[b])
    return left.x - right.x || left.y - right.y || a.localeCompare(b)
  })
  for (const file of rest) push(file)

  return screens
}

/**
 * The URL of the HTML of an artboard, derived from the URL of the index.
 *
 * The index lives at the end of the path (`…/design/<id>/<token>/canvas.json`), so the
 * folder is the URL without that last segment and the file comes in encoded — the same
 * format the companion builds (`encodeURIComponent` per segment). Without
 * `canvas.json` at the end (a URL already in the folder, for example), the file comes in after
 * a slash instead of eating the last segment: cutting the token would leave the screen
 * without authorization.
 */
export function artboardUrl(canvasUrl: string, file: string): string | null {
  const clean = canvasUrl.trim().split('#')[0].split('?')[0]
  const cut = clean.lastIndexOf('/')
  if (cut <= 0) return null

  const last = clean.slice(cut + 1)
  const folder =
    last === ''
      ? clean
      : last.toLowerCase() === INDEX_FILE
        ? clean.slice(0, cut + 1)
        : `${clean}/`

  const relative = file
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  return relative ? folder + relative : null
}

/** What to write in the chip and in the screen bar: the title from the index, or the file. */
export function screenLabel(screen: DesignScreen): string {
  const title = screen.title?.trim()
  if (title) return title
  const name = screen.file.split('/').pop() ?? screen.file
  return name.replace(/\.html?$/i, '')
}

type Status = 'loading' | 'error' | 'ready'

/** Centered box for the states without a screen (loading, error, empty canvas). */
function StateBox({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View testID={testID} className="flex-1 items-center justify-center gap-2 px-8">
      {children}
    </View>
  )
}

export function DesignViewer({ piece }: PieceViewerProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const { height: windowHeight } = useWindowDimensions()
  const insets = useSafeAreaInsets()

  const [status, setStatus] = useState<Status>('loading')
  const [screens, setScreens] = useState<DesignScreen[]>([])
  const [detail, setDetail] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  // A new piece (or "try again") starts from scratch: nothing from the previous canvas
  // survives the source change. Adjustment DURING rendering, the React pattern
  // for state derived from a prop — in an effect there would be an intermediate
  // render showing the screens of the previous piece.
  const sourceKey = `${piece.url}#${attempt}`
  const [seenSource, setSeenSource] = useState(sourceKey)
  if (seenSource !== sourceKey) {
    setSeenSource(sourceKey)
    setStatus('loading')
    setDetail(null)
    setScreens([])
    setSelected(null)
  }

  // The canvas index is the only read of this layer. `AbortController` because
  // closing the full screen unmounts the viewer in the middle of the fetch, and a `setState`
  // after that is noise.
  useEffect(() => {
    let alive = true
    const controller = new AbortController()

    fetch(piece.url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<unknown>
      })
      .then((json) => {
        if (!alive) return
        setScreens(parseDesignCanvas(json))
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (!alive) return
        // Expired token, desktop off, canvas removed: the same error
        // box, with the concrete reason below and a "try again" that redoes the
        // fetch (the index may come back; the signed URL, may not).
        setDetail(err instanceof Error ? err.message : String(err))
        setStatus('error')
      })

    return () => {
      alive = false
      controller.abort()
    }
  }, [piece.url, attempt])

  // The open screen is stored by the file NAME, not by the index: an index
  // survives crooked to a canvas that changed, a name either is in the canvas or
  // is not.
  const index = useMemo(() => {
    if (!selected) return 0
    const found = screens.findIndex((screen) => screen.file === selected)
    return found >= 0 ? found : 0
  }, [screens, selected])

  const screen = screens[index]
  const src = screen ? artboardUrl(piece.url, screen.file) : null

  const viewHeight = Math.max(
    MIN_VIEW_HEIGHT,
    windowHeight - insets.top - insets.bottom - SHELL_HEADER - PIECE_CHROME - NAV_ROW - STRIP_ROW,
  )

  const goTo = useCallback(
    (next: number) => {
      const target = screens[Math.min(Math.max(next, 0), screens.length - 1)]
      if (target) setSelected(target.file)
    },
    [screens],
  )

  if (status === 'loading') {
    return (
      <StateBox testID="design-loading">
        <ActivityIndicator color={tokens.primary} accessibilityLabel={t('parts.preview.loading')} />
        <Text className="text-xs" style={{ color: tokens.mutedForeground }}>
          {t('parts.preview.loading')}
        </Text>
      </StateBox>
    )
  }

  if (status === 'error') {
    return (
      <StateBox testID="design-error">
        <AlertCircle size={20} color={tokens.mutedForeground} />
        <Text className="text-center text-xs" style={{ color: tokens.mutedForeground }}>
          {t('parts.preview.error')}
        </Text>
        {detail ? (
          <Text
            numberOfLines={2}
            className="text-center text-[10px]"
            style={{ color: tokens.mutedForeground, opacity: 0.7 }}
          >
            {detail}
          </Text>
        ) : null}
        <Pressable
          testID="design-retry"
          onPress={() => setAttempt((n) => n + 1)}
          accessibilityRole="button"
          accessibilityLabel={t('parts.preview.retry')}
          hitSlop={8}
          className="mt-1 flex-row items-center gap-1 rounded-md px-2 py-1"
          style={{ backgroundColor: tokens.muted }}
        >
          <RotateCw size={12} color={tokens.foreground} />
          <Text className="text-xs" style={{ color: tokens.foreground }}>
            {t('parts.preview.retry')}
          </Text>
        </Pressable>
      </StateBox>
    )
  }

  // Canvas without a screen (freshly created index, emptied piece) or an artboard that cannot
  // be addressed: a real empty state. No WebView pointing at the
  // JSON and no broken tile — that is the bug the gallery already had.
  if (!screen || !src) {
    return (
      <StateBox testID="design-empty">
        <Frame size={22} color={tokens.mutedForeground} />
        <Text className="text-center text-xs" style={{ color: tokens.mutedForeground }}>
          {t('parts.preview.empty')}
        </Text>
        {screens.length === 0 ? (
          <Text className="text-[10px]" style={{ color: tokens.mutedForeground, opacity: 0.7 }}>
            {t('pieces.meta.screens', { count: 0 })}
          </Text>
        ) : null}
      </StateBox>
    )
  }

  const prev = index > 0 ? screens[index - 1] : null
  const next = index < screens.length - 1 ? screens[index + 1] : null

  return (
    <View className="flex-1">
      {/* The screen itself: only it is mounted, and the interaction is all its own. */}
      <PieceView
        src={src}
        title={screenLabel(screen)}
        poster={piece.cover}
        revision={0}
        height={viewHeight}
        expandable={false}
        loadingLabel={t('parts.preview.loading')}
        errorLabel={t('parts.preview.error')}
      />

      <View className="flex-row items-center justify-center gap-4 px-3" style={{ height: NAV_ROW }}>
        <Pressable
          testID="design-prev"
          onPress={() => goTo(index - 1)}
          disabled={!prev}
          accessibilityRole="button"
          accessibilityState={{ disabled: !prev }}
          accessibilityLabel={prev ? t('pieces.open', { title: screenLabel(prev) }) : undefined}
          hitSlop={10}
          className="h-8 w-8 items-center justify-center rounded-full"
          style={{ backgroundColor: tokens.muted, opacity: prev ? 1 : 0.4 }}
        >
          <ChevronLeft size={16} color={tokens.foreground} />
        </Pressable>

        <Text testID="design-counter" className="text-xs" style={{ color: tokens.mutedForeground }}>
          {index + 1} / {screens.length}
        </Text>

        <Pressable
          testID="design-next"
          onPress={() => goTo(index + 1)}
          disabled={!next}
          accessibilityRole="button"
          accessibilityState={{ disabled: !next }}
          accessibilityLabel={next ? t('pieces.open', { title: screenLabel(next) }) : undefined}
          hitSlop={10}
          className="h-8 w-8 items-center justify-center rounded-full"
          style={{ backgroundColor: tokens.muted, opacity: next ? 1 : 0.4 }}
        >
          <ChevronRight size={16} color={tokens.foreground} />
        </Pressable>
      </View>

      {/* The "screen select": the strip scrolls horizontally, the open screen stays
          marked, and a tap jumps straight to it. The home indicator band
          counts toward the height of the strip (the screen already discounted it from its own height),
          otherwise the chips would sit under it. */}
      <ScrollView
        testID="design-screens"
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ height: STRIP_ROW + insets.bottom }}
        contentContainerStyle={{
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: 12,
          paddingBottom: insets.bottom,
        }}
      >
        {screens.map((item, i) => {
          const active = i === index
          const label = screenLabel(item)
          return (
            <Pressable
              key={item.file}
              testID={`design-screen-${i}`}
              onPress={() => setSelected(item.file)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={t('pieces.open', { title: label })}
              className="rounded-full border px-2.5 py-1"
              style={{
                backgroundColor: active ? withAlpha(tokens.primary, 0.18) : tokens.card,
                borderColor: active ? tokens.primary : tokens.border,
              }}
            >
              <Text
                numberOfLines={1}
                className="text-[11px]"
                style={{ color: active ? tokens.foreground : tokens.mutedForeground, maxWidth: 140 }}
              >
                {label}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
}
