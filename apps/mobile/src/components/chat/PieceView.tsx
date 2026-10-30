/**
 * WebView host for an HTML "piece" coming from the desktop.
 *
 * The desktop rewrites the URL before sending it to the phone (`companion-media`):
 * what arrives here is already an absolute http URL, with the token in the path. This
 * component does NOT assemble any URL — it only renders what it received, whether from
 * a URL or from the HTML the phone itself wrote (the mermaid diagram).
 * An empty source (an old part in the cache, a file that could not be served) degrades
 * to a discreet card instead of a hole in the conversation.
 *
 * The API is the same for all piece types because they all share the same
 * problem: an HTML that needs a host, a poster while loading, an error
 * that cannot bring down the bubble and a full screen for what does not fit in the width
 * of the phone. Artifact and document use it now; motion, design and slides use it
 * later, without inventing a second host.
 */
import { useCallback, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { WebView, type WebViewProps } from 'react-native-webview'
import { Image } from 'expo-image'
import { AlertCircle, Maximize2, RotateCw, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { UnavailablePart } from './parts/UnavailablePart'

type WebViewErrorEvent = Parameters<NonNullable<WebViewProps['onError']>>[0]
type WebViewHttpErrorEvent = Parameters<NonNullable<WebViewProps['onHttpError']>>[0]

export interface PieceViewProps {
  /** Absolute http URL of the HTML (already rewritten by the desktop). Empty = no preview. */
  src?: string
  /**
   * HTML assembled on the phone itself, without a file on the desktop — the mermaid
   * diagram has no URL to serve. It takes precedence over `src` when both
   * come; empty in both = "preview unavailable" card.
   */
  html?: string
  /** Title in the bar of the card and in the header of the full screen. */
  title?: string
  /** Poster shown while the HTML loads — usually the `thumb` of the part. */
  poster?: string
  /**
   * Revision of the content (`revision` of the part). The desktop rewrites the same
   * file at the same path, so without this the WebView would keep showing the
   * previous version after an `update_artifact`.
   */
  revision?: number
  /** Height of the inline host, in px. Default 320. */
  height?: number
  /** Shows the expand button to full screen. Default true. */
  expandable?: boolean
  /** Extra content right below the host (the document buttons, for example). */
  footer?: ReactNode
  /** Label of the empty state (missing URL). */
  emptyLabel?: string
  /** Label of the loading state, for the screen reader. */
  loadingLabel?: string
  /** Label of the error state. */
  errorLabel?: string
  /** Notifies the caller when the page does not load (network, 404, expired token). */
  onError?: (message: string) => void
  /**
   * Messages of the document (`window.ReactNativeWebView.postMessage`). It is through
   * here that a piece that draws itself — the mermaid diagram — reports the
   * height it needs.
   */
  onMessage?: (data: string) => void
  /**
   * Channel to talk to the page after it loads (seek, paging).
   *
   * Called on every `onLoadEnd`, with the `injectJavaScript` of the WebView that has just
   * loaded: the caller stores the `inject` and uses it for as long as the page lives.
   * It is the only path of motion for a motion piece — it has no clock
   * of its own and only moves when someone sends a frame —, and also the one of navigation
   * of a deck, which the HTML does not bring. The `inject` delivered is the one of the right instance
   * (inline or full screen), so a seek never lands in a hidden WebView.
   */
  onReady?: (inject: (js: string) => void) => void
}

type LoadState = 'loading' | 'ready' | 'error'

export function PieceView({
  src,
  html,
  title,
  poster,
  revision,
  height = 320,
  expandable = true,
  footer,
  emptyLabel,
  loadingLabel,
  errorLabel,
  onError,
  onMessage,
  onReady,
}: PieceViewProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()

  // Each part speaks its own language ("Artifact preview", "Loading document").
  // Without a label from the caller, the translated generic one — never a loose string.
  const emptyText = emptyLabel ?? t('parts.preview.empty')
  const loadingText = loadingLabel ?? t('parts.preview.loading')
  const errorText = errorLabel ?? t('parts.preview.error')

  const [state, setState] = useState<LoadState>('loading')
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)

  // A new URL (or a new revision of the same file) starts over from loading: the error/ready
  // latch cannot survive the source change, otherwise the part re-emitted with a fresh
  // token would show the error of the previous one. Adjustment during rendering
  // (the React pattern for state derived from a prop) instead of an effect: the effect
  // would leave an intermediate render showing the state of the previous source.
  // With `html` the identity of the source is the document itself — the diagram is
  // assembled here, it has no URL. Changing the theme or the diagram remounts the WebView.
  const sourceKey = src ? `${src}#${revision ?? 0}` : `html:${html ?? ''}`
  const [seenSource, setSeenSource] = useState(sourceKey)
  if (seenSource !== sourceKey) {
    setSeenSource(sourceKey)
    setState('loading')
    setErrorDetail(null)
  }

  const fail = useCallback(
    (detail: string | null) => {
      setState('error')
      setErrorDetail(detail)
      onError?.(detail ?? 'load failed')
    },
    [onError],
  )

  const retry = useCallback(() => {
    setState('loading')
    setErrorDetail(null)
    setAttempt((n) => n + 1)
  }, [])

  // `attempt` in the key forces a new WebView on every attempt — `reload()` does not
  // solve it when the problem was the HTTP response itself.
  const webKey = `${sourceKey}#${attempt}`

  const handleError = useCallback(
    (event: WebViewErrorEvent) => fail(event.nativeEvent.description || null),
    [fail],
  )

  const handleHttpError = useCallback(
    (event: WebViewHttpErrorEvent) => fail(`HTTP ${event.nativeEvent.statusCode}`),
    [fail],
  )

  // One target per instance: the `inject` delivered to `onReady` has to talk to the
  // WebView that has just loaded, not to the last one that existed. With the full screen
  // open there are two mounted and the `onLoadEnd` of the bottom one would arrive with the target of the
  // top one if it were a single one.
  //
  // The wrapper is state, not `useRef`: the `WebView` is a component of a package
  // the React compiler does not know, so handing (or reading) a ref of it
  // in any callback is treated as "ref read during render" by
  // `react-hooks/refs`. Written by the ref callback — which React runs at
  // commit, never during render — the wrapper stores the instance without that risk.
  const [web] = useState(() => ({
    inline: null as WebView | null,
    fullscreen: null as WebView | null,
  }))

  const renderWeb = (expanded: boolean) => (
    <WebView
      key={webKey}
      ref={(instance: WebView | null) => {
        if (expanded) web.fullscreen = instance
        else web.inline = instance
      }}
      source={html ? { html } : { uri: src as string }}
      style={styles.web}
      // The page of the piece pulls its own assets by relative path (CSS,
      // font, clip) and may point outside — no restrictive whitelist.
      originWhitelist={['*']}
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      // The piece is a document, not a browser: `window.open` would open a
      // window RN has nowhere to show.
      setSupportMultipleWindows={false}
      onLoadStart={() => setState((prev) => (prev === 'error' ? prev : 'loading'))}
      onLoadEnd={() => {
        setState((prev) => (prev === 'error' ? prev : 'ready'))
        if (!onReady) return
        // The target is read here, in the event, and the instance is captured now: whoever
        // receives the `inject` talks to the WebView that has just loaded, and no
        // mutable object crosses the render.
        const instance = expanded ? web.fullscreen : web.inline
        onReady((js) => instance?.injectJavaScript(js))
      }}
      onError={handleError}
      onHttpError={handleHttpError}
      onMessage={(event) => onMessage?.(event.nativeEvent.data)}
      accessibilityLabel={title}
      testID={expanded ? 'piece-view-fullscreen' : 'piece-view'}
    />
  )

  // Old part in the cache (or a file the desktop could not serve): the
  // card stays there, saying what it was, instead of vanishing.
  if (!src && !html) {
    return <UnavailablePart title={title} label={emptyText} testID="piece-empty" />
  }

  return (
    <>
      <View
        className="mt-2 w-full overflow-hidden rounded-lg"
        style={{ borderWidth: 1, borderColor: tokens.border }}
      >
        <View
          className="flex-row items-center gap-2 px-3 py-2"
          style={{ backgroundColor: tokens.muted }}
        >
          <Text
            numberOfLines={1}
            className="flex-1 text-xs font-medium"
            style={{ color: tokens.foreground }}
          >
            {title ?? ''}
          </Text>
          {expandable ? (
            <Pressable
              onPress={() => setFullscreen(true)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t('parts.preview.expand')}
            >
              <Maximize2 size={14} color={tokens.mutedForeground} />
            </Pressable>
          ) : null}
        </View>

        <View style={{ height }}>
          {state !== 'error' && renderWeb(false)}

          {state === 'loading' ? (
            <View style={styles.overlay} pointerEvents="none">
              {poster ? (
                <Image
                  source={poster}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  // Poster is decoration: if the thumb fails, the spinner already handles it.
                  accessibilityIgnoresInvertColors
                />
              ) : null}
              <View style={styles.overlayScrim}>
                <ActivityIndicator color={tokens.primary} accessibilityLabel={loadingText} />
              </View>
            </View>
          ) : null}

          {state === 'error' ? (
            <View style={styles.overlay}>
              <AlertCircle size={18} color={tokens.mutedForeground} />
              <Text className="text-xs" style={{ color: tokens.mutedForeground, textAlign: 'center' }}>
                {errorText}
              </Text>
              <Pressable
                onPress={retry}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('parts.preview.retry')}
                className="flex-row items-center gap-1 rounded-md px-2 py-1"
                style={{ backgroundColor: tokens.muted }}
              >
                <RotateCw size={12} color={tokens.foreground} />
                <Text className="text-xs" style={{ color: tokens.foreground }}>
                  {t('parts.preview.retry')}
                </Text>
              </Pressable>
              {errorDetail ? (
                <Text
                  numberOfLines={2}
                  className="text-[10px]"
                  style={{ color: tokens.mutedForeground, opacity: 0.7, textAlign: 'center' }}
                >
                  {errorDetail}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>

        {footer}
      </View>

      <Modal
        visible={fullscreen}
        animationType="slide"
        onRequestClose={() => setFullscreen(false)}
        statusBarTranslucent
      >
        <View style={[styles.fullscreen, { backgroundColor: tokens.background, paddingTop: insets.top }]}>
          <View className="flex-row items-center gap-2 px-3 py-2">
            <Text
              numberOfLines={1}
              className="flex-1 text-sm font-medium"
              style={{ color: tokens.foreground }}
            >
              {title ?? ''}
            </Text>
            <Pressable
              onPress={() => setFullscreen(false)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t('pieces.closeFullscreen')}
            >
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>
          <View style={{ flex: 1, paddingBottom: insets.bottom }}>{renderWeb(true)}</View>
        </View>
      </Modal>
    </>
  )
}

const fill = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: 'transparent' },
  overlay: {
    ...fill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  overlayScrim: {
    ...fill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  fullscreen: { flex: 1 },
})
