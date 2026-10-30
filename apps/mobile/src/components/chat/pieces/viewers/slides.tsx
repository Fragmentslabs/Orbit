/**
 * Slides on the phone — the paginated deck, one slide per screen.
 *
 * HOW A DECK IS ASSEMBLED (read in `apps/desktop/electron/lib/slides`):
 *
 * - `deck-template.ts` writes N `<section class="slide">` in sequence in the
 *   `<body>`: in the SOURCE the slides are **stacked**, one under the other, and the
 *   document has no navigation at all.
 * - `slides-runtime.ts` is what builds the stage: it collects the sections, throws them all
 *   inside `.orbit-slides-stage` and leaves them **overlaid**
 *   (`position:absolute`, one `.is-current` visible at a time), scaled 1280×720
 *   (or whatever `<meta name="orbit-slides">` declares) to fit the window, and
 *   obeys keyboard, click and `postMessage`. Whoever paginates is the APP, never the
 *   document.
 *
 * THE PHONE PATH DOES NOT HAVE THAT RUNTIME. `companion-assets.ts` serves the
 * file from disk as it is (only the font URLs are rewritten); the runtime
 * exists only inside the Electron `orbit-slides://` protocol
 * (`slides-store.ts`). The WebView therefore receives the STACKED deck without
 * scaling: on a 390-point screen, sections drawn for 1280 are squeezed,
 * and there is no way to walk between them.
 *
 * It is case (2) of the usual question: without a stage, the slides are not scrollable
 * pages, they are layers the app needs to flip. That is why this viewer does
 * what the desktop does, with the two halves the app has:
 *
 * - the STAGE comes in by injection (`onReady` → `injectJavaScript`, the channel that
 *   `PieceView` exposes precisely for "seek, paging"): the `src={piece.url}`
 *   remains the deck document — relative assets, token in the folder and
 *   CSP stay intact —, and the script collects the sections, hides the stacked ones and
 *   builds the layers in the same synchronous block, without blinking;
 * - the NAVIGATION belongs to the app: the side arrows and the counter are RN, and they send
 *   `window.orbitSlides.go(n)` through the same `inject`. The swipe stays inside the
 *   document, which is the only place that receives the touch over the WebView.
 *
 * The document reports the index back through `onMessage` (`ready`/`change`/`empty`), which
 * is what keeps the counter and arrows in sync with the slide on screen.
 *
 * The stage API (`window.orbitSlides.go/next/prev`, `data-index`,
 * `.is-current`) is the same as the desktop runtime on purpose: one day
 * `companion-assets` will inject the real runtime and this script becomes only the
 * phone fallback.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { ChevronLeft, ChevronRight, Presentation } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

import { PieceView } from '../../PieceView'

import type { PieceViewerProps } from './index'

/** Mark of the bridge messages, the same one as the desktop runtime (`SLIDES_SOURCE`). */
export const SLIDES_SOURCE = 'orbit-slides'

/**
 * Fixed heights of what is not ours: the bar of `PieceViewer` (h-8 of the button +
 * py-2.5 + the border) and what `PieceView` puts around the WebView (the
 * title bar, the `mt-2` margin and the borders). Added to the top inset, it is what is left
 * of body for the deck.
 */
const VIEWER_HEADER_HEIGHT = 53
const PIECE_CHROME_HEIGHT = 45

/** Side of the arrow button: the comfortable touch target (44pt) + `hitSlop`. */
const ARROW_SIZE = 44

type DeckStatus = 'loading' | 'ready' | 'error' | 'empty'

/** What the deck document tells the app. */
export interface SlidesMessage {
  type: 'ready' | 'change' | 'empty'
  index?: number
  total?: number
}

/** The message of the deck, or `null` when it is not ours (or is not JSON). */
export function readSlidesMessage(data: string): SlidesMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const message = parsed as Record<string, unknown>
  if (message.source !== SLIDES_SOURCE) return null
  const type = message.type
  if (type !== 'ready' && type !== 'change' && type !== 'empty') return null
  const toIndex = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined
  const index = toIndex(message.index)
  const total = toIndex(message.total)
  return {
    type,
    ...(index === undefined ? {} : { index }),
    ...(total === undefined || total <= 0 ? {} : { total }),
  }
}

/**
 * The geometry of the stage. It only describes the layer and the scale — the deck color
 * keeps belonging to the deck; what is the app's here is the frame around the 16:9
 * (`--orbit-bg`, filled by the theme).
 */
const STAGE_CSS = `
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:var(--orbit-bg)}
#orbit-slides-root{position:fixed;inset:0;overflow:hidden;background:var(--orbit-bg);z-index:2147483000}
.orbit-slides-stage{position:absolute;left:50%;top:50%;transform-origin:center center}
.orbit-slides-stage>.orbit-slide{position:absolute;inset:0;width:100%;height:100%;visibility:hidden;opacity:0;pointer-events:none}
.orbit-slides-stage>.orbit-slide.is-current{visibility:visible;opacity:1;pointer-events:auto}
.orbit-slides-stage aside.notes,.orbit-slides-stage [data-notes]{display:none}
`.trim()

/**
 * The stage injected into the deck document — the half that is missing on the phone.
 *
 * It runs in the `onLoadEnd` of the WebView, with the document already read (that is why there is no
 * `DOMContentLoaded` here), and it is idempotent: a retry remounts the WebView, but
 * two injects into the same page cannot build two stages.
 *
 * No template literals in there on purpose: this text is a TS string, and
 * a `${` in the middle of it would break the assembly (the same caution as
 * `slides-runtime.ts`). `__ORBIT_SLIDES_CONFIG__` is replaced in `deckStageSource`.
 */
const STAGE_RUNTIME = `(function () {
  if (window.__orbitSlidesMobile) return
  window.__orbitSlidesMobile = true

  var SOURCE = 'orbit-slides'
  var config = __ORBIT_SLIDES_CONFIG__

  function post(message) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          source: SOURCE,
          type: message.type,
          index: message.index,
          total: message.total
        }))
      }
    } catch (error) {}
  }

  var width = 1280
  var height = 720
  var meta = document.querySelector('meta[name="orbit-slides"]')
  if (meta) {
    var pairs = String(meta.getAttribute('content') || '').split(/[,;]/)
    for (var p = 0; p < pairs.length; p++) {
      var pair = pairs[p]
      var at = pair.indexOf('=')
      if (at < 0) continue
      var key = pair.slice(0, at).trim()
      var num = Number(pair.slice(at + 1).trim())
      if (!isFinite(num) || num <= 0) continue
      if (key === 'width') width = Math.round(num)
      if (key === 'height') height = Math.round(num)
    }
  }

  // Only the TOP-level sections: a .slide inside another (a cover that repeats
  // the pattern) is not a stop of the presentation.
  var nodes = document.querySelectorAll('.slide')
  var sections = []
  for (var i = 0; i < nodes.length; i++) {
    if (!nodes[i].closest('.orbit-slides-stage')) sections.push(nodes[i])
  }
  if (!sections.length) {
    post({ type: 'empty' })
    return
  }

  // No blinking of the stacked deck: hide, build the stage and show everything in the
  // SAME synchronous block, so the browser does not paint in the middle.
  document.documentElement.style.visibility = 'hidden'

  var style = document.createElement('style')
  style.textContent = config.css
  document.head.appendChild(style)

  var root = document.createElement('div')
  root.id = 'orbit-slides-root'
  var stage = document.createElement('div')
  stage.className = 'orbit-slides-stage'
  stage.style.width = width + 'px'
  stage.style.height = height + 'px'
  root.appendChild(stage)
  document.body.appendChild(root)

  for (var s = 0; s < sections.length; s++) {
    var section = sections[s]
    section.classList.add('orbit-slide')
    // The deck can draw its own number with [data-index] (the house theme
    // uses it in the corner of the slide).
    section.setAttribute('data-index', String(s + 1))
    stage.appendChild(section)
  }

  var index = 0

  function paint() {
    for (var k = 0; k < sections.length; k++) {
      if (k === index) sections[k].classList.add('is-current')
      else sections[k].classList.remove('is-current')
    }
  }

  function go(value) {
    var target = Math.max(0, Math.min(sections.length - 1, Math.round(Number(value)) || 0))
    if (target === index) return
    index = target
    paint()
    post({ type: 'change', index: index, total: sections.length })
  }

  function fit() {
    var vw = window.innerWidth || 1
    var vh = window.innerHeight || 1
    var scale = Math.min(vw / width, vh / height)
    stage.style.transform = 'translate(-50%, -50%) scale(' + scale + ')'
    // translate BEFORE the scale: the stage can be bigger than the window, and an item
    // bigger than the container does not get centered — it leaks to the right.
    stage.style.transformOrigin = 'center center'
  }

  // Horizontal swipe: the stage fills the whole screen, so it is the natural target (and
  // it is the only touch path the WebView leaves to the document). The 40px
  // limit and the ratio against the Y axis separate a swipe from a scroll and from a tap.
  var startX = 0
  var startY = 0
  var startAt = 0
  root.addEventListener('touchstart', function (event) {
    var touch = event.changedTouches && event.changedTouches[0]
    if (!touch) return
    startX = touch.clientX
    startY = touch.clientY
    startAt = Date.now()
  }, { passive: true })
  root.addEventListener('touchend', function (event) {
    var touch = event.changedTouches && event.changedTouches[0]
    if (!touch) return
    var dx = touch.clientX - startX
    var dy = touch.clientY - startY
    if (Date.now() - startAt > 900) return
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.4) return
    go(index + (dx < 0 ? 1 : -1))
  }, { passive: true })

  // The API the app calls through injectJavaScript — the same names as the desktop
  // runtime, for the day it is injected on the server.
  window.orbitSlides = {
    version: 1,
    get index() { return index },
    total: sections.length,
    go: go,
    next: function () { go(index + 1) },
    prev: function () { go(index - 1) }
  }

  window.addEventListener('resize', fit)
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit).catch(function () {})

  paint()
  fit()
  document.documentElement.style.visibility = ''
  post({ type: 'ready', index: 0, total: sections.length })
})()`

/**
 * What is injected into the WebView: the CSS of the stage (with the app color) and the script,
 * in a single call. Pure and testable.
 */
export function deckStageSource(background: string): string {
  const css = `:root{--orbit-bg:${background}}${STAGE_CSS}`
  // `</script>` does not appear here (it is `injectJavaScript`, not a `<script>`), but
  // the `<` of the CSS would become noise in the JSON: escaping keeps the text opaque.
  const config = JSON.stringify({ css }).replace(/</g, '\\u003c')
  return STAGE_RUNTIME.replace('__ORBIT_SLIDES_CONFIG__', config)
}

/** Side arrow overlaid on the deck. `disabled` at the ends: there is nowhere to go. */
function SlideArrow({
  side,
  label,
  color,
  background,
  border,
  disabled,
  onPress,
}: {
  side: 'previous' | 'next'
  label: string
  color: string
  background: string
  border: string
  disabled: boolean
  onPress: () => void
}) {
  const Icon = side === 'previous' ? ChevronLeft : ChevronRight
  const position: StyleProp<ViewStyle> =
    side === 'previous' ? styles.arrowLeft : styles.arrowRight

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      testID={`slides-${side}`}
      style={[
        styles.arrow,
        position,
        { backgroundColor: background, borderColor: border },
        disabled ? styles.arrowDisabled : null,
      ]}
    >
      <Icon size={20} color={color} />
    </Pressable>
  )
}

export function SlidesViewer({ piece }: PieceViewerProps) {
  const { height: windowHeight } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const background = tokens.background
  const { t } = useTranslation()

  const [status, setStatus] = useState<DeckStatus>('loading')
  const [index, setIndex] = useState(0)
  const [total, setTotal] = useState(0)

  // The `inject` of the WebView that has just loaded. A ref, not state: sending a
  // command to the deck must not render anything.
  const inject = useRef<((js: string) => void) | null>(null)

  // The background of the stage comes by ref, not by closure: the React Compiler cannot
  // preserve a `useCallback` that closes over a value derived from
  // `getThemeTokens(...)`, and the callback needs to stay the same on every load.
  // The ref is only read at load time (never during render).
  const backgroundRef = useRef(background)
  useEffect(() => {
    backgroundRef.current = background
  }, [background])

  // Every load goes through here — including the one of "try again", which
  // remounts the WebView and therefore loses the stage of the previous page.
  const handleReady = useCallback((send: (js: string) => void) => {
    inject.current = send
    send(deckStageSource(backgroundRef.current))
  }, [])

  const handleMessage = useCallback((data: string) => {
    const message = readSlidesMessage(data)
    if (!message) return
    if (message.type === 'empty') {
      setStatus('empty')
      return
    }
    if (message.total) setTotal(message.total)
    if (message.index !== undefined) setIndex(message.index)
    setStatus('ready')
  }, [])

  const goTo = useCallback((target: number) => {
    // The stage belongs to whoever loaded it; without it (page still loading, inject not
    // arrived) the arrow cannot promise a slide that will not show up.
    inject.current?.(`window.orbitSlides && window.orbitSlides.go(${target})`)
  }, [])

  // Body of the deck: what is left of the screen after the header of `PieceViewer` and
  // the frame of `PieceView` (which is not ours and cannot be hidden).
  const bodyHeight = Math.max(
    240,
    windowHeight - insets.top - VIEWER_HEADER_HEIGHT - PIECE_CHROME_HEIGHT,
  )

  const ready = status === 'ready'
  const counter =
    ready && total > 0
      ? t('pieces.slides.counter', {
          index: index + 1,
          count: total,
        })
      : null

  // Empty deck (no `.slide` in the document): the stage has nothing to build and the
  // WebView leaves the scene — a deck that is not a deck is not a blank screen.
  if (status === 'empty') {
    return (
      <View style={styles.center} testID="slides-empty">
        <Presentation size={22} color={tokens.mutedForeground} />
        <Text className="text-sm font-medium" style={{ color: tokens.foreground }}>
          {t('parts.preview.empty')}
        </Text>
        <Text className="text-xs" style={{ color: tokens.mutedForeground }}>
          {t('pieces.meta.slides', { count: 0 })}
        </Text>
      </View>
    )
  }

  return (
    <View className="flex-1" style={styles.stage}>
      <PieceView
        src={piece.url}
        // While the total is unknown the bar stays without text: repeating the
        // title here would say twice what the header already says.
        title={total > 0 ? t('pieces.meta.slides', { count: total }) : ''}
        poster={piece.cover}
        revision={0}
        height={bodyHeight}
        expandable={false}
        onMessage={handleMessage}
        onError={() => setStatus('error')}
        onReady={handleReady}
      />

      {ready && total > 1 ? (
        <>
          <SlideArrow
            side="previous"
            label={t('pieces.slides.previous')}
            color={tokens.foreground}
            background={withAlpha(tokens.background, 0.74)}
            border={tokens.border}
            disabled={index === 0}
            onPress={() => goTo(index - 1)}
          />
          <SlideArrow
            side="next"
            label={t('pieces.slides.next')}
            color={tokens.foreground}
            background={withAlpha(tokens.background, 0.74)}
            border={tokens.border}
            disabled={index >= total - 1}
            onPress={() => goTo(index + 1)}
          />
        </>
      ) : null}

      {counter ? (
        // Over the deck, in the footer: pointer events off, otherwise the counter eats the
        // touch that belonged to the swipe.
        <View pointerEvents="none" style={styles.counterRow}>
          <View
            style={[
              styles.counter,
              { backgroundColor: withAlpha(tokens.background, 0.78), borderColor: tokens.border },
            ]}
          >
            <Text
              className="text-[11px] font-medium"
              style={{ color: tokens.mutedForeground }}
              testID="slides-counter"
            >
              {counter}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  stage: { position: 'relative' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 24 },
  arrow: {
    position: 'absolute',
    top: '50%',
    marginTop: -ARROW_SIZE / 2,
    width: ARROW_SIZE,
    height: ARROW_SIZE,
    borderRadius: ARROW_SIZE / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowLeft: { left: 6 },
  arrowRight: { right: 6 },
  // At the ends the arrow stays visible (you can see that a side exists), but
  // faded and without touch.
  arrowDisabled: { opacity: 0.28 },
  counterRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingBottom: 12,
  },
  counter: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
})
