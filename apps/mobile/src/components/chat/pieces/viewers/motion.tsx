/**
 * Motion on the phone: the player.
 *
 * The motion piece does NOT have a clock of its own. It declares the format in an
 * `<meta name="orbit-motion" content="width=…,fps=30,duration=6">` (or in
 * `window.orbitMotion`) and only moves when someone calls
 * `window.orbitMotion.seek(frame)` — always an INTEGER frame; the desktop runtime
 * converts it to seconds (`t = frame / fps`). That is why the scrubber here
 * is no decoration: without a seek per frame, the piece stays still at the first one.
 *
 * The speech path with the page is the `onReady` of `PieceView`, which delivers the
 * `injectJavaScript` of the WebView after the load. Three injections leave from here:
 *
 *  1. the probe that asks for the format (the answer comes back by postMessage);
 *  2. the `seek(frame)` — the motion itself;
 *  3. the framing (`zoom`) of the piece on the stage: the composition is a 1920×1080
 *     document (the motion guide forbids responsive layout), and without scaling on a
 *     phone you would see its top-left corner.
 *
 * No URL assembled here: `piece.url` already comes signed from the desktop and the
 * relative assets of the piece load along with it because of the token in the path.
 */
import { Pause, Play, Repeat } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

import { PieceView } from '../../PieceView'

import type { PieceViewerProps } from './index'

/** The default fps of the contract (`MOTION_FPS` of the desktop runtime). */
const DEFAULT_FPS = 30
/** Mark of the messages of this screen — the piece may post others, and they are not ours. */
const MESSAGE_SOURCE = 'orbit-motion-player'
/** Frame of the host: `mt-2` + the title bar of `PieceView` + the borders. */
const HOST_CHROME = 42
/** Control bar, without the bottom inset. */
const CONTROLS_HEIGHT = 52
/** Below this the piece stops being seen; better a low stage than none. */
const MIN_STAGE = 120

export interface MotionSpec {
  /** Frames per second declared by the piece (or the default of the contract). */
  fps: number
  /** Length in FRAMES — the unit of `seek`. */
  frames: number
  /** Size of the composition document, to fit it on the stage. */
  width: number
  height: number
  /** The page exposes `orbitMotion.seek`: without that nothing moves. */
  seekable: boolean
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * What the page answered, in the order of precedence of the desktop runtime:
 * `durationInFrames` is canonical and wins over everything; otherwise the declared duration in
 * seconds counts, then the GSAP timeline and finally the `<meta>`. The fps is resolved
 * before any calculation, because seconds become frames with it.
 *
 * `fallbackSeconds` is `piece.count` (the duration the desktop already knows):
 * it only comes in when the page declares no length at all — an old piece, or a
 * runtime that never got to run. Without any of that, `null`: better a disabled
 * control than an invented duration.
 */
export function resolveSpec(
  raw: Record<string, unknown>,
  fallbackSeconds?: number,
): MotionSpec | null {
  const fps = positive(raw.fps) || positive(raw.metaFps) || DEFAULT_FPS
  const declaredFrames = positive(raw.durationInFrames)
  let frames = declaredFrames ? Math.max(1, Math.round(declaredFrames)) : 0
  if (!frames) {
    const seconds =
      positive(raw.duration) || positive(raw.timeline) || positive(raw.metaDuration) || positive(fallbackSeconds)
    if (seconds > 0) frames = Math.max(1, Math.round(seconds * fps))
  }
  if (!frames) return null
  return {
    fps,
    frames,
    width: positive(raw.width) || positive(raw.metaWidth) || 1920,
    height: positive(raw.height) || positive(raw.metaHeight) || 1080,
    seekable: raw.seek === true,
  }
}

/**
 * `0:01` — minutes only when they exist, seconds always with two digits.
 *
 * It rounds instead of truncating because the number is read together with the ruler: truncated,
 * the last frame of a 3 s piece (2.97 s) would show as `0:02 / 0:03` with
 * the ruler at the end.
 */
export function formatTime(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}

/** The frame under the finger: `locationX` is relative to the track, so ratio = x/width. */
export function frameAtX(x: number, width: number, frames: number): number {
  if (!(width > 0) || !(frames > 0)) return 0
  const ratio = Math.min(1, Math.max(0, x / width))
  return Math.round(ratio * (frames - 1))
}

/**
 * The probe. Reads what the page has without touching anything: `orbitMotion` (declared
 * by the composition, or resolved by the runtime when it was injected), the
 * `<meta>` of the document itself, the GSAP timeline and whether there is a `seek` to
 * call. It comes back by `postMessage` — there is no return value in
 * `injectJavaScript`.
 */
const PROBE_JS = `(function () {
  var reply = function (payload) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      }
    } catch (err) {}
  };
  try {
    var api = window.orbitMotion || null;
    var meta = document.querySelector('meta[name="orbit-motion"]');
    var metaFps = 0, metaDuration = 0, metaWidth = 0, metaHeight = 0;
    if (meta) {
      var pairs = String(meta.getAttribute('content') || '').split(/[,;]/);
      for (var i = 0; i < pairs.length; i++) {
        var at = pairs[i].indexOf('=');
        if (at < 0) continue;
        var key = pairs[i].slice(0, at).trim();
        var num = Number(pairs[i].slice(at + 1).trim());
        if (!isFinite(num) || num <= 0) continue;
        if (key === 'fps') metaFps = num;
        else if (key === 'duration') metaDuration = num;
        else if (key === 'width') metaWidth = num;
        else if (key === 'height') metaHeight = num;
      }
    }
    var timeline = 0;
    try {
      if (window.orbitTimeline && typeof window.orbitTimeline.duration === 'function') {
        var seconds = window.orbitTimeline.duration();
        if (typeof seconds === 'number' && isFinite(seconds) && seconds > 0) timeline = seconds;
      }
    } catch (err) {}
    reply({
      source: '${MESSAGE_SOURCE}',
      type: 'spec',
      fps: api && typeof api.fps === 'number' ? api.fps : 0,
      duration: api && typeof api.duration === 'number' ? api.duration : 0,
      durationInFrames: api && typeof api.durationInFrames === 'number' ? api.durationInFrames : 0,
      width: api && typeof api.width === 'number' ? api.width : 0,
      height: api && typeof api.height === 'number' ? api.height : 0,
      metaFps: metaFps,
      metaDuration: metaDuration,
      metaWidth: metaWidth,
      metaHeight: metaHeight,
      timeline: timeline,
      seek: !!(api && typeof api.seek === 'function')
    });
  } catch (err) {
    reply({ source: '${MESSAGE_SOURCE}', type: 'error', message: String((err && err.message) || err) });
  }
})();
true;`

/**
 * The motion: a whole frame. The `try` exists because `seek` is code of the
 * piece — if it throws, the screen needs to know (and stop), not die silently.
 */
export function seekScript(frame: number): string {
  return `(function () {
  try {
    var api = window.orbitMotion;
    if (api && typeof api.seek === 'function') api.seek(${Math.max(0, Math.round(frame))});
  } catch (err) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        source: '${MESSAGE_SOURCE}', type: 'error', message: String((err && err.message) || err)
      }));
    } catch (ignored) {}
  }
})();
true;`
}

/**
 * Scales the document of the piece to fit the stage.
 *
 * The composition is a fixed-size page (1920×1080 in the common case), so on a
 * phone the WebView would show only its corner. `zoom` on `<html>` reflows the
 * document to the right visual size — unlike `transform`, which would scale it
 * without shrinking the scrollable area. The `<meta viewport>` exists so the WebView does not
 * use the virtual 980px viewport of the Android "desktop" mode.
 */
export function fitScript(scale: number): string {
  return `(function () {
  try {
    var head = document.head || document.documentElement;
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      head.appendChild(meta);
    }
    meta.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
    document.documentElement.style.zoom = '${scale.toFixed(4)}';
  } catch (err) {}
})();
true;`
}

interface PageReply {
  source?: unknown
  type?: unknown
}

export function MotionViewer({ piece }: PieceViewerProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()
  const dimensions = useWindowDimensions()

  // Space the shell gave the viewer (flex:1, already without the full-screen header).
  // Measured instead of deduced: the header is not from this screen and would change the calculation.
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  const [spec, setSpec] = useState<MotionSpec | null>(null)
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  // The page refused the seek (or its runtime threw): the control stops
  // pretending it works.
  const [broken, setBroken] = useState(false)
  // How many loads the page had. Each one asks for a new probe and a new seek —
  // `frame` alone does not change when the WebView reloads underneath.
  const [loads, setLoads] = useState(0)
  const [trackWidth, setTrackWidth] = useState(0)

  const injectRef = useRef<((js: string) => void) | null>(null)
  const frameRef = useRef(0)

  const stageWidth = Math.max(0, box?.width ?? dimensions.width)
  const stageHeight = Math.max(
    MIN_STAGE,
    (box?.height ?? dimensions.height - 120) - CONTROLS_HEIGHT - HOST_CHROME - insets.bottom,
  )

  const duration = spec ? spec.frames / spec.fps : piece.count ?? 0
  const position = spec ? frame / spec.fps : 0
  const canSeek = Boolean(spec?.seekable) && !broken
  const ratio = spec && spec.frames > 1 ? Math.min(1, Math.max(0, frame / (spec.frames - 1))) : 0
  const timeLabel = `${formatTime(position)} / ${duration > 0 ? formatTime(duration) : '–:–'}`

  // Mirror of the frame for the play clock: the effect reads the starting value
  // when it begins, and a stale state would make the first tick jump.
  useEffect(() => {
    frameRef.current = frame
  }, [frame])

  // The only motion of the piece leaves from here: one `seek` per displayed frame.
  useEffect(() => {
    if (loads === 0) return
    injectRef.current?.(seekScript(frame))
  }, [loads, frame])

  // Play: clock of the screen, not of the page. Each tick derives the frame from the elapsed
  // time (and not from a counter) so as not to accumulate timer drift.
  useEffect(() => {
    if (!playing || !spec) return
    const stepMs = 1000 / spec.fps
    const origin = Date.now()
    const base = frameRef.current
    const timer = setInterval(() => {
      const advanced = base + Math.floor((Date.now() - origin) / stepMs)
      if (advanced < spec.frames) {
        setFrame(advanced)
        return
      }
      if (loop) {
        setFrame(advanced % spec.frames)
        return
      }
      setFrame(spec.frames - 1)
      setPlaying(false)
    }, Math.max(16, Math.round(stepMs)))
    return () => clearInterval(timer)
  }, [playing, spec, loop])

  // Framing: only after knowing the size of the document (the probe answered)
  // and redone when the stage changes — rotating the phone changes the scale.
  useEffect(() => {
    if (!spec || loads === 0 || stageWidth <= 0) return
    const scale = Math.min(stageWidth / spec.width, stageHeight / spec.height)
    if (!(scale > 0) || !Number.isFinite(scale)) return
    injectRef.current?.(fitScript(scale))
  }, [spec, loads, stageWidth, stageHeight])

  const handleReady = useCallback((inject: (js: string) => void) => {
    injectRef.current = inject
    setBroken(false)
    setPlaying(false)
    setFrame(0)
    frameRef.current = 0
    inject(PROBE_JS)
    setLoads((n) => n + 1)
  }, [])

  const handleMessage = useCallback(
    (data: string) => {
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        return
      }
      if (!payload || typeof payload !== 'object') return
      const reply = payload as PageReply
      if (reply.source !== MESSAGE_SOURCE) return
      if (reply.type === 'error') {
        setBroken(true)
        setPlaying(false)
        return
      }
      if (reply.type !== 'spec') return
      const next = resolveSpec(reply as Record<string, unknown>, piece.count)
      setSpec(next)
      if (!next?.seekable) setPlaying(false)
    },
    [piece.count],
  )

  const togglePlay = useCallback(() => {
    if (!spec || !spec.seekable || broken) return
    if (playing) {
      setPlaying(false)
      return
    }
    // Stopped at the end, tapping starts over — otherwise the button would do nothing.
    if (frameRef.current >= spec.frames - 1) {
      frameRef.current = 0
      setFrame(0)
    }
    setPlaying(true)
  }, [spec, broken, playing])

  // Dragging the ruler pauses: play is a clock that starts from a fixed frame, and
  // continuing from another point would require restarting it in the middle of the gesture.
  const seekTo = useCallback(
    (next: number) => {
      if (!spec) return
      const clamped = Math.min(spec.frames - 1, Math.max(0, Math.round(next)))
      setPlaying(false)
      frameRef.current = clamped
      setFrame(clamped)
    },
    [spec],
  )

  const onTrackTouch = useCallback(
    (event: GestureResponderEvent) => {
      if (!spec || trackWidth <= 0) return
      seekTo(frameAtX(event.nativeEvent.locationX, trackWidth, spec.frames))
    },
    [spec, trackWidth, seekTo],
  )

  const onTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width)
  }, [])

  // The stage does not change while the piece plays — and playing re-renders this component
  // on every frame. Without the memo, the WebView host would be rebuilt 30 times per
  // second for nothing, along with the `inject`s it fires through `onReady`.
  const stage = useMemo(
    () => (
      <PieceView
        src={piece.url}
        title={piece.title}
        revision={0}
        height={stageHeight}
        expandable={false}
        loadingLabel={t('parts.preview.loading')}
        errorLabel={t('parts.preview.error')}
        onReady={handleReady}
        onMessage={handleMessage}
        onError={() => {
          setBroken(true)
          setPlaying(false)
        }}
      />
    ),
    [piece.url, piece.title, stageHeight, t, handleReady, handleMessage],
  )

  return (
    <View
      className="flex-1"
      onLayout={(event) =>
        setBox({
          width: event.nativeEvent.layout.width,
          height: event.nativeEvent.layout.height,
        })
      }
    >
      {stage}

      <View
        className="flex-row items-center gap-2 px-3"
        style={{
          height: CONTROLS_HEIGHT + insets.bottom,
          paddingBottom: insets.bottom,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: tokens.border,
          backgroundColor: tokens.background,
        }}
      >
        <Pressable
          testID="motion-play"
          onPress={togglePlay}
          disabled={!canSeek}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSeek }}
          accessibilityLabel={t(playing ? 'pieces.motion.pause' : 'pieces.motion.play')}
          className="h-9 w-9 items-center justify-center rounded-full"
          style={{ backgroundColor: tokens.muted, opacity: canSeek ? 1 : 0.4 }}
        >
          {playing ? (
            <Pause size={16} color={tokens.foreground} />
          ) : (
            <Play size={16} color={tokens.foreground} />
          )}
        </Pressable>

        {/* The ruler: touch and drag become a frame. `locationX` already comes relative to the
            track, so the ratio x/width is the progress itself. */}
        <View
          testID="motion-track"
          accessibilityRole="adjustable"
          // The name of the piece is what the person recognizes; there is no locale key
          // for "timeline" (see report).
          accessibilityLabel={piece.title?.trim() || t('pieces.kind.motion')}
          // `aria-value*` and not `accessibilityValue`: they are the same thing on
          // native and, in the test WebView (react-native-web), only these reach the
          // DOM — it is through them that the screen reader announces the position.
          aria-valuemin={0}
          aria-valuemax={spec ? spec.frames - 1 : 0}
          aria-valuenow={frame}
          aria-valuetext={timeLabel}
          style={styles.trackTouch}
          onLayout={onTrackLayout}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={onTrackTouch}
          onResponderMove={onTrackTouch}
        >
          <View style={[styles.rail, { backgroundColor: tokens.secondary }]}>
            <View
              style={{ width: `${ratio * 100}%`, height: '100%', backgroundColor: tokens.primary }}
            />
          </View>
          <View
            style={[
              styles.thumb,
              {
                backgroundColor: tokens.primary,
                borderColor: tokens.background,
                left: Math.max(0, Math.min(trackWidth, ratio * trackWidth)) - THUMB / 2,
              },
            ]}
          />
        </View>

        <Text
          testID="motion-time"
          numberOfLines={1}
          className="text-[11px]"
          style={{ color: tokens.mutedForeground, fontVariant: ['tabular-nums'] }}
        >
          {timeLabel}
        </Text>

        <Pressable
          testID="motion-loop"
          onPress={() => setLoop((prev) => !prev)}
          hitSlop={8}
          accessibilityRole="switch"
          accessibilityState={{ checked: loop }}
          accessibilityLabel={t('configSheet.loop')}
          className="h-8 w-8 items-center justify-center rounded-full"
        >
          <Repeat size={15} color={loop ? tokens.foreground : tokens.mutedForeground} />
        </Pressable>
      </View>
    </View>
  )
}

const THUMB = 14

const styles = StyleSheet.create({
  trackTouch: {
    flex: 1,
    height: 32,
    justifyContent: 'center',
    marginHorizontal: THUMB / 2,
  },
  rail: { height: 6, borderRadius: 999, overflow: 'hidden' },
  thumb: {
    position: 'absolute',
    pointerEvents: 'none',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 3,
  },
})
