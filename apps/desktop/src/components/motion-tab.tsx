import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  Box,
  CircleCheck,
  Clapperboard,
  Download,
  Film,
  ImageIcon,
  Layers,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Music,
  PanelBottomClose,
  PanelBottomOpen,
  Pause,
  Play,
  Repeat,
  RotateCw,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Type,
  X,
  type LucideIcon,
} from "lucide-react"
import { motionTimecode } from "@shared/chat"
import { MOTION_SCHEME } from "@shared/media"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Hint } from "@/components/ui/hint"
import { SettingSelect } from "@/src/components/settings-row"
import { Switch } from "@/components/ui/switch"
import { IconAction } from "@/src/components/ai/artifact-part"
import {
  motionApi,
  type MotionLayersResult,
  type MotionRenderFormat,
  type MotionRenderOptions,
  type MotionRenderQuality,
} from "@/src/lib/ipc"
import {
  MOTION_AUDIO_SEEK_S,
  motionTrackVolume,
  motionAudioRate,
  motionTrackEnd,
  motionTrackIsLive,
} from "@/src/lib/motion-audio-range"
import { usePanelStore } from "@/src/stores/panel-store"
import { cn } from "@/lib/utils"
import { FULLSCREEN_OVERLAY_CLASS } from "@/src/lib/fullscreen-overlay"
import { ActionsFeed, FullscreenChatFeed, FullscreenComposer } from "@/src/components/fullscreen-dock"
import { Truncate } from "@/components/ui/truncated-text"
import { MotionPropsForm } from "@/src/components/motion-props-form"
import { changedCount, defaultValues, srcWithProps, toOverrides, type MotionPropsInfo, type PropFormValues } from "@/src/lib/motion-props-form"

/**
 * Preview of a motion composition in the right panel tab — the stage where the
 * user follows, live, the agent editing the piece.
 *
 * The iframe loads the registered FOLDER through `orbit-motion://<id>/<path>`; whoever
 * injects the seek runtime is the scheme handler itself (video/motion-store),
 * so no script is injected here — one only talks to it through
 * postMessage, with the `source: "orbit-motion"` field:
 *
 *   iframe → panel: ready (format and duration), time (frame played), error,
 *                   assets (fonts that did not load)
 *   panel → iframe: seek(frame), play, pause, loop
 *
 * The time unit is a WHOLE FRAME, at the fps the COMPOSITION declares (30 is only
 * the default of whoever does not declare it) — the same as the render contract, so that what the
 * user approves here is exactly what comes out there. The transport moves one second
 * per arrow (one frame with Shift), and the timecode is `mm:ss:ff`.
 *
 * Below the ruler, the LAYERS: who enters and leaves the scene, and when — measured in the
 * main process in an offscreen window (motion:layers), because the composition is free HTML and
 * declares no layer at all. Clicking a layer takes it along with the frame to
 * the chat note.
 *
 * The iframe runs in `sandbox="allow-scripts"` WITHOUT `allow-same-origin` (opaque
 * origin: no Orbit window, no cookies, no storage), like the artifact. It is
 * from that opaque origin that the care with the bridge comes: there is no origin to
 * check, what checks is the `event.source === contentWindow` of our iframe.
 */

/** fps of a composition that declares none (the contract default). */
const DEFAULT_FPS = 30

/** Mark of the bridge messages (see MOTION_SOURCE in the main motion-runtime). */
const MOTION_SOURCE = "orbit-motion"

/** Stage format while the runtime does not announce the composition's one. */
const DEFAULT_SPEC: MotionSpec = { width: 1920, height: 1080, durationInFrames: 0 }

/** Without "ready" in that time, the page is not going to answer: it says why, instead of spinning. */
const LOAD_TIMEOUT_MS = 10_000

/** Fraction of the panel height the stage may occupy — the rest belongs to the timeline. */
const STAGE_MAX_RATIO = 0.5
const STAGE_MAX_RATIO_FULLSCREEN = 0.62

/** The tab remounts on every switch: the split the person chose is kept between them. */
const STAGE_HEIGHT_KEY = "orbit.motion.stageHeight"
const readStageHeight = (): number | null => {
  try {
    const value = Number(localStorage.getItem(STAGE_HEIGHT_KEY))
    if (Number.isFinite(value) && value >= 120) return value
  } catch {
    // no storage (or blocked): the default rule is enough
  }
  return null
}
const writeStageHeight = (value: number | null) => {
  try {
    if (value === null) localStorage.removeItem(STAGE_HEIGHT_KEY)
    else localStorage.setItem(STAGE_HEIGHT_KEY, String(value))
  } catch {
    // no storage: the split lives only as long as the tab
  }
}

interface MotionSpec {
  width: number
  height: number
  /** 0 = not announced yet (the composition declares the length). */
  durationInFrames: number
  /** fps declared by the composition; absent = 30 (contract). */
  fps?: number
}

type MotionLayer = MotionLayersResult["layers"][number]

/**
 * The icon of each layer type. The label says the NAME, not what the element is —
 * a heading and a photo may both be called ".caption" —, so the type comes
 * measured from the DOM by the runtime and is what differentiates two elements in the list.
 */
const LAYER_ICON: Record<MotionLayer["kind"], LucideIcon> = {
  text: Type,
  image: ImageIcon,
  video: Film,
  audio: Music,
  other: Box,
}

type RuntimeMessage =
  | { type: "ready"; durationInFrames: number; width: number; height: number; fps: number; version: number }
  | { type: "time"; frame: number }
  | { type: "error"; message: string; stack?: string }
  | { type: "assets"; failedFonts: string[] }

type RenderState =
  | { status: "idle" }
  | { status: "running"; frame: number; total: number }
  | { status: "done"; path: string; audioPath?: string }
  | { status: "error"; message: string }

/** "Save project": the .zip of the whole piece, with a manifest (see motion-project). */
type ProjectState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "done"; path: string; files?: number }
  | { status: "error"; message: string }

type LayersState =
  | { status: "idle" }
  | { status: "loading"; previous: MotionLayer[] }
  | { status: "ready"; layers: MotionLayer[] }
  | { status: "error"; message: string }

/**
 * Validates an iframe → panel message. Same rules as the runtime's parseMotionMessage
 * (which lives in the main process and is not importable from here): what does not match is
 * discarded in silence, because the composition is untrusted content.
 */
function parseRuntimeMessage(raw: unknown): RuntimeMessage | null {
  if (!raw || typeof raw !== "object") return null
  const msg = raw as Record<string, unknown>
  if (msg.source !== MOTION_SOURCE) return null
  if (msg.type === "ready") {
    if (typeof msg.durationInFrames !== "number" || !Number.isFinite(msg.durationInFrames)) return null
    return {
      type: "ready",
      durationInFrames: Math.max(1, Math.round(msg.durationInFrames)),
      width: typeof msg.width === "number" ? msg.width : DEFAULT_SPEC.width,
      height: typeof msg.height === "number" ? msg.height : DEFAULT_SPEC.height,
      // Old runtime (or a message without the field) falls into the contract default.
      fps: typeof msg.fps === "number" && Number.isFinite(msg.fps) && msg.fps > 0 ? msg.fps : DEFAULT_FPS,
      version: typeof msg.version === "number" ? msg.version : 0,
    }
  }
  if (msg.type === "time") {
    return typeof msg.frame === "number" && Number.isFinite(msg.frame)
      ? { type: "time", frame: Math.max(0, Math.round(msg.frame)) }
      : null
  }
  if (msg.type === "error") {
    if (typeof msg.message !== "string") return null
    return { type: "error", message: msg.message, stack: typeof msg.stack === "string" ? msg.stack : undefined }
  }
  if (msg.type === "assets") {
    const fonts = Array.isArray(msg.failedFonts)
      ? msg.failedFonts.filter((f): f is string => typeof f === "string")
      : []
    return { type: "assets", failedFonts: fonts }
  }
  return null
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/**
 * Path of the entry INSIDE the registered folder — what the URL
 * `orbit-motion://<id>/<relative-path>` serves. The event brings the relative one
 * (the normal case); if the absolute one comes, there is no way to rebuild the composition folder
 * from here and the file name stays.
 */
function entryPath(entry: string): string {
  const cleaned = entry.replace(/\\/g, "/").replace(/^file:\/\//, "")
  const relative = /^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith("/") ? baseName(cleaned) : cleaned.replace(/^\.\//, "")
  return relative.split("/").map(encodeURIComponent).join("/")
}

/** Is the layer in the scene at this frame? */
function onScreenAt(layer: MotionLayer, frame: number): boolean {
  return layer.spans.some(([a, b]) => frame >= a && frame <= b)
}

/** Step of the ruler marks (in seconds) to fit ~8 labels in the width. */
function rulerStep(seconds: number): number {
  return [1, 2, 5, 10, 15, 30, 60].find((s) => seconds / s <= 8) ?? 60
}

/**
 * Formats the render modal offers, in the order in which they appear. The value is the
 * one of the IPC union (`motion:render`) — the label says what the file is and the hint,
 * what it is for: the difference between the three is transparency, which only
 * mov/webm carry.
 */
const RENDER_FORMATS: { value: MotionRenderFormat; labelKey: string; hintKey: string }[] = [
  { value: "mp4", labelKey: "motion.formatMp4", hintKey: "motion.formatMp4Hint" },
  { value: "mov-alpha", labelKey: "motion.formatMovAlpha", hintKey: "motion.formatMovAlphaHint" },
  { value: "webm-alpha", labelKey: "motion.formatWebmAlpha", hintKey: "motion.formatWebmAlphaHint" },
]

export function MotionTab({
  motionId,
  entry,
  path,
  title,
  sessionId,
}: {
  motionId?: string
  entry?: string
  /** Absolute path of the entry — the address the chat note hands to the agent. */
  path?: string
  title: string
  /** Conversation that owns the tab — the fullscreen dock talks to it (chat or code mode). */
  sessionId?: string
}) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const stageWrapRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  /** The sound of the piece plays OUTSIDE the iframe (the stage is a sandbox: no autoplay, no
   *  control): it is these elements the transport commands, one per track, in the
   *  order in which the manifest declared them. */
  const audioRefs = useRef<(HTMLAudioElement | null)[]>([])

  const [spec, setSpec] = useState<MotionSpec | null>(null)
  /** The COMPOSITION fps, not a fixed 30: ruler, timecode and playhead follow it.
   *  Declared here (and not next to the layout) because the audio effect, further below,
   *  also converts frame into seconds. */
  const fps = spec?.fps ?? DEFAULT_FPS
  const [readyCount, setReadyCount] = useState(0)
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(false)
  const [measuredFps, setMeasuredFps] = useState<number | null>(null)
  const [runtimeError, setRuntimeError] = useState<{ message: string; stack?: string } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [failedFonts, setFailedFonts] = useState<string[]>([])
  const [reloads, setReloads] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [composerPinned, setComposerPinned] = useState(false)
  const [chatPinned, setChatPinned] = useState(false)
  const [actionsPinned, setActionsPinned] = useState(false)
  useEffect(() => {
    if (fullscreen) return
    setComposerPinned(false)
    setChatPinned(false)
    setActionsPinned(false)
  }, [fullscreen])
  const [box, setBox] = useState({ width: 0, height: 0 })
  /** Height of the stage area once the divider above the timeline is dragged (px).
   *  `null` = nobody decided it: the stage keeps the panel's rule. */
  const [stageHeight, setStageHeight] = useState<number | null>(() => readStageHeight())
  /** Timeline/layers card open? Closed, the stage is the whole tab and the piece plays clean.
   *  The card is HIDDEN, not unmounted: the <audio> elements live inside it. */
  const [timelineOpen, setTimelineOpen] = useState(true)
  /** During the drag the wrapper is sized straight in the DOM (no render per frame);
   *  this flag is what tells the measuring effect to trust that height. */
  const stageDragging = useRef(false)
  const [render, setRender] = useState<RenderState>({ status: "idle" })
  const [project, setProject] = useState<ProjectState>({ status: "idle" })
  /**
   * The render modal. The header button only OPENS it; what renders is the button
   * inside — that way the person sees what is going to come out (format, size, fps, audio)
   * before paying the capture minutes, instead of finding out afterwards.
   */
  const [renderOpen, setRenderOpen] = useState(false)
  // Props of the piece (props.json): the form, the values the person typed, and what the preview shows.
  const [propsInfo, setPropsInfo] = useState<MotionPropsInfo | null>(null)
  const [propValues, setPropValues] = useState<PropFormValues>({})
  const [propsOpen, setPropsOpen] = useState(false)
  const [renderOptions, setRenderOptions] = useState<{
    format: MotionRenderFormat
    quality: MotionRenderQuality
    /** 0 = the composition fps. */
    fps: number
    separateAudio: boolean
  }>({ format: "mp4", quality: "balanced", fps: 0, separateAudio: false })
  const [layers, setLayers] = useState<LayersState>({ status: "idle" })
  const [selectedName, setSelectedName] = useState<string | null>(null)
  /** The tracks of the piece, measured in the main process along with the layers — through the SAME
   *  resolution the render uses: what the timeline draws and what plays in the
   *  preview are the files that go in the video, at the same instants. */
  const [audio, setAudio] = useState<{
    tracks: {
      name: string
      url: string | null
      start: number
      end: number | null
      offset?: number
      gainDb?: number
      fadeIn?: number
      fadeOut?: number
      automation?: { at: number; db: number }[]
    }[]
    error: string | null
  } | null>(null)
  /** The REAL length of each file, measured by the element itself when the
   *  metadata arrives: it is what closes the window of a track the manifest did not
   *  delimit (see `motionTrackEnd`), instead of stretching it to the end of the piece. */
  const [audioDurations, setAudioDurations] = useState<Record<string, number>>({})
  const audioTracks = audio?.tracks ?? []
  // What is in focus may be a DOM LAYER or a SOUND track. The sound is not
  // an element (it plays outside the stage — see motion-audio.ts), but it is selected the
  // same way; it is through here that the tab knows which of the two is selected.
  const selectedAudio = audioTracks.find((track) => track.name === selectedName) ?? null
  const measureAudio = (url: string | null, el: HTMLAudioElement | null) => {
    const duration = el?.duration
    if (!url || duration === undefined || !Number.isFinite(duration) || duration <= 0) return
    setAudioDurations((prev) => (prev[url] === duration ? prev : { ...prev, [url]: duration }))
  }
  /** The measurement of the track file. The key is the URL (and not the position in the list):
   *  that way a new piece does not inherit the previous one's measurement for an instant. Stable
   *  between renders — it enters the deps of the effect that commands the sound. */
  const trackDuration = useCallback(
    (track: { url: string | null; offset?: number }): number | null => {
      const duration = track.url ? (audioDurations[track.url] ?? null) : null
      // The file plays from the `offset` (initial cut of a video): what
      // is left for the track window is the rest of it, not the whole length.
      return duration === null ? null : Math.max(0, duration - (track.offset ?? 0))
    },
    [audioDurations],
  )
  /** `?r=` is what makes the regenerated voice enter the scene: the URL changes on every reload,
   *  and without swapping it the elements would keep playing the old bytes. It is also for
   *  that reason that the media can be served without `no-store` (see the scheme handler). */
  const audioSrc = (url: string | null): string | null => (url ? `${url}?r=${reloads}` : null)

  /**
   * The tracks follow the TRANSPORT: the iframe is the clock (it is what sends
   * `time` on every frame), the audio elements are followers. Concentrating that
   * in one effect — instead of spreading play/pause across play, pause, ruler drag,
   * frame step, loop and reload — is what guarantees that no new path
   * forgets the sound, which is exactly how this bug is born.
   *
   * Each track has its WINDOW (`start`/`end`): outside it the element stays
   * stopped, and the transport instant is translated to the timeline of the
   * file itself (`at - start`). The re-sync slack also covers the loop wrap,
   * when the playhead jumps to zero.
   */
  useEffect(() => {
    const at = frame / fps
    const SEEK_EPSILON_S = 0.02
    const tracks = audio?.tracks ?? []
    tracks.forEach((track, index) => {
      const el = audioRefs.current[index]
      if (!el || !track.url) return
      // Position in the FILE: the time since the entry of the track, plus the initial cut.
      const local = at - track.start + (track.offset ?? 0)
      // The window comes from the SAME function that draws the bar: without `end` in the manifest
      // it is closed by the real length of the file, and not by the end of the piece.
      const within = motionTrackIsLive(track, trackDuration(track), at)
      // The level the render would mix at this instant (gain, ramps, volume curve): the
      // element follows it, so the fade that was asked for is also the one that is heard.
      el.volume = motionTrackVolume(track, motionTrackEnd(track, trackDuration(track)), at)
      if (!within) {
        if (!el.paused) el.pause()
        if (el.playbackRate !== 1) el.playbackRate = 1
        return
      }
      if (!playing) {
        // Stopped, the sound sits on the playhead frame — and at natural rate, so that the
        // next play starts from the right place and at the right time.
        if (el.playbackRate !== 1) el.playbackRate = 1
        if (Math.abs(el.currentTime - local) > SEEK_EPSILON_S) el.currentTime = local
        if (!el.paused) el.pause()
        return
      }
      // Running, the re-sync splits into two: REAL repositioning (drag
      // of the ruler, cut, entry into the track) is seek; drift is rate.
      //
      // It was only seek, and that started to hurt when the scheme began announcing
      // tracks: before, Chromium IGNORED the `currentTime` (the sound played with a fixed
      // slack and nobody noticed); now that it obeys, every drift became
      // buffer discard and file downgrade — the sound stuttered and never
      // settled. Seek goes back to being only what is repositioning.
      const drift = el.currentTime - local
      if (Math.abs(drift) > MOTION_AUDIO_SEEK_S) {
        el.currentTime = local
        if (el.playbackRate !== 1) el.playbackRate = 1
      } else {
        // The state of the ELEMENT itself is the hysteresis: is it already correcting?
        // Without it, with the drift oscillating at the threshold, the rate kept switching on and
        // off — and every restart of the resample is a click.
        const engaged = Math.abs(el.playbackRate - 1) > 0.001
        const rate = motionAudioRate(drift, engaged)
        // Slack of 0.5%: readjusting the rate on every frame would be trading one
        // artifact for another.
        if (Math.abs(el.playbackRate - rate) > 0.005) el.playbackRate = rate
      }
      if (el.paused) void el.play().catch(() => {})
    })
  }, [audio, fps, playing, frame, reloads, trackDuration])
  const addQuote = usePanelStore((s) => s.addQuote)
  const quotes = usePanelStore((s) => s.quotes)
  /**
   * The layer that is pinned to the next chat message (the "mark"). The row button
   * stays lit while it is that one — without this the gesture would have no visible
   * response, and the only proof would be there in the composer attachment.
   */
  const quoteLayer = useMemo(() => {
    const quote = quotes.find((item) => item.kind === "motion")
    return quote?.kind === "motion" ? (quote.layer ?? null) : null
  }, [quotes])

  /** The other side of "mark": the SOUND track pinned to the next message. */
  const quoteAudio = useMemo(() => {
    const quote = quotes.find((item) => item.kind === "motion")
    return quote?.kind === "motion" ? (quote.audio ?? null) : null
  }, [quotes])

  // Mirrors for the handlers that cannot depend on the render (the message
  // listener and the shortcuts are registered only once).
  const frameRef = useRef(0)
  const playingRef = useRef(false)
  const loopRef = useRef(false)
  const specRef = useRef<MotionSpec>(DEFAULT_SPEC)
  /** Frame to resume after a remount (reloading goes back to the SAME instant). */
  const restoreRef = useRef<number | null>(null)
  /** Instants of the received `time`: it is what measures the REAL fps of the preview. */
  const tickTimes = useRef<number[]>([])
  const lastFpsAt = useRef(0)
  /** Has "ready" arrived since the last (re)load? It is what the load diagnosis consults. */
  const loadedRef = useRef(false)

  const layout = spec ?? DEFAULT_SPEC
  const total = spec?.durationInFrames ?? 0

  const propsSchema = propsInfo?.exists && !propsInfo.errors.length ? propsInfo.schema : null
  // What differs from the defaults AND is valid: it is what the preview loads and the render receives.
  const form = useMemo(
    () => (propsSchema ? toOverrides(propsSchema, propValues) : { overrides: {}, errors: {} }),
    [propsSchema, propValues],
  )
  const overridesKey = JSON.stringify(form.overrides)
  // The preview waits for the person to stop typing: every change reloads the composition.
  const [appliedKey, setAppliedKey] = useState(overridesKey)
  useEffect(() => {
    const timer = setTimeout(() => setAppliedKey(overridesKey), 350)
    return () => clearTimeout(timer)
  }, [overridesKey])

  const src = useMemo(() => {
    const base = motionId && entry ? `${MOTION_SCHEME}://${motionId}/${entryPath(entry)}?r=${reloads}` : ""
    return srcWithProps(base, JSON.parse(appliedKey) as Record<string, string | number | boolean>)
  }, [motionId, entry, reloads, appliedKey])

  // The props the piece declares: the form is built from props.json, and it is read again whenever the
  // folder changes (the agent may have just added or edited one).
  useEffect(() => {
    if (!motionId) {
      setPropsInfo(null)
      return
    }
    let alive = true
    void motionApi
      .props(motionId)
      .then((info) => {
        if (!alive) return
        setPropsInfo(info)
        if (info.exists && !info.errors.length) {
          // Keep what was typed for the props that still exist; new ones start at their default.
          setPropValues((prev) => {
            const next = defaultValues(info.schema)
            for (const name of Object.keys(next)) if (name in prev) next[name] = prev[name]
            return next
          })
        } else setPropValues({})
      })
      .catch(() => alive && setPropsInfo(null))
    return () => {
      alive = false
    }
  }, [motionId, reloads])

  /** Panel → iframe command. With no window mounted, there is no one to send it to. */
  const post = useCallback((message: Record<string, unknown>) => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    win.postMessage({ source: MOTION_SOURCE, ...message }, "*")
  }, [])

  /** Goes to a frame (whole, inside the composition) and tells the iframe. */
  const seek = useCallback(
    (target: number) => {
      const next = total > 0 ? Math.max(0, Math.min(Math.round(target), total - 1)) : Math.max(0, Math.round(target))
      frameRef.current = next
      setFrame(next)
      post({ type: "seek", frame: next })
    },
    [post, total],
  )

  const stopClock = useCallback(() => {
    playingRef.current = false
    setPlaying(false)
    tickTimes.current = []
    lastFpsAt.current = 0
    setMeasuredFps(null)
  }, [])

  const pause = useCallback(() => {
    post({ type: "pause" })
    stopClock()
  }, [post, stopClock])

  const togglePlay = useCallback(() => {
    if (playingRef.current) {
      pause()
      return
    }
    // Stopped at the last frame, the runtime play would end in the same instant:
    // it starts over from zero, like any player.
    if (total > 0 && frameRef.current >= total - 1) seek(0)
    playingRef.current = true
    setPlaying(true)
    post({ type: "play" })
  }, [pause, post, seek, total])

  /** Moves N frames: the runtime play would overwrite the seek, so it pauses first. */
  const stepFrames = useCallback(
    (delta: number) => {
      if (playingRef.current) pause()
      seek(frameRef.current + delta)
    },
    [pause, seek],
  )

  /** Jumps to an instant (start/end): same pause, same reason. */
  const jump = useCallback(
    (target: number) => {
      if (playingRef.current) pause()
      seek(target)
    },
    [pause, seek],
  )

  const toggleLoop = useCallback(() => {
    const next = !loopRef.current
    loopRef.current = next
    setLoop(next)
    post({ type: "loop", on: next })
  }, [post])

  const layerList = useMemo(
    () => (layers.status === "ready" ? layers.layers : layers.status === "loading" ? layers.previous : []),
    [layers],
  )

  /**
   * Comment the instant: it pins the frame of NOW to the next chat message,
   * with what is in focus — the DOM layer or the sound track — and the layers in
   * the scene. The agent knows which moment AND which element the sentence speaks of ("here the
   * title enters fast").
   *
   * The frame is frozen on the click — the attachment is a pointing gesture, not a
   * playhead that keeps playing. Clicking again replaces the previous instant in-
   * stead of accumulating (see addQuote in panel-store).
   */
  const comment = useCallback(
    (target?: { layer?: string; audio?: string }) => {
      if (!entry) return
      const at = frameRef.current
      const onScreen = layerList.filter((l) => onScreenAt(l, at)).map((l) => l.name)
      // The target comes from the ROW button when it was the one that called; without it what counts is what
      // is in focus. Layer and sound are DIFFERENT fields: calling a sound a "layer"
      // would send the agent to look in the stage for an element that is not there.
      const layer = target ? target.layer : selectedAudio ? undefined : (selectedName ?? undefined)
      const audio = target ? target.audio : (selectedAudio?.name ?? undefined)
      addQuote({
        kind: "motion",
        file: entry,
        name: title,
        frame: at,
        fps,
        ...(path ? { path } : {}),
        ...(layer ? { layer } : {}),
        ...(audio ? { audio } : {}),
        ...(onScreen.length ? { onScreen: onScreen.slice(0, 12) } : {}),
      })
    },
    [addQuote, entry, title, path, selectedName, selectedAudio, layerList, fps],
  )

  // --------------------------------------------------------- iframe bridge
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = iframeRef.current?.contentWindow
      // The iframe origin is opaque (sandbox without allow-same-origin): what says that
      // the message is from THIS iframe is the source window, not the origin.
      if (!win || event.source !== win) return
      const msg = parseRuntimeMessage(event.data)
      if (!msg) return
      if (msg.type === "ready") {
        const next: MotionSpec = {
          width: msg.width,
          height: msg.height,
          durationInFrames: msg.durationInFrames,
          fps: msg.fps,
        }
        specRef.current = next
        loadedRef.current = true
        setSpec(next)
        setReadyCount((n) => n + 1)
        // New page: the warnings of the previous one no longer count.
        setRuntimeError(null)
        setLoadError(null)
        setFailedFonts([])
        // The loop lives in the runtime and is lost on remount: it reasserts the state.
        post({ type: "loop", on: loopRef.current })
        const restore = restoreRef.current
        restoreRef.current = null
        // The composition may have become shorter between the two versions: the
        // frame to resume is clamped to the NEW length.
        if (restore != null) seek(Math.min(restore, msg.durationInFrames - 1))
        return
      }
      if (msg.type === "time") {
        frameRef.current = msg.frame
        setFrame(msg.frame)
        const now = performance.now()
        const times = tickTimes.current
        times.push(now)
        while (times.length > 0 && now - times[0] > 1000) times.shift()
        if (times.length >= 2 && now - lastFpsAt.current > 400) {
          lastFpsAt.current = now
          setMeasuredFps(Math.round(((times.length - 1) * 1000) / (now - times[0])))
        }
        if (msg.frame >= specRef.current.durationInFrames - 1) {
          // Repeat: the runtime play STOPS at the last frame even with loop
          // on (its `frame >= total - 1` wins over the loop case), so
          // what restarts is the panel — it goes back to zero and orders it to play again.
          if (loopRef.current) {
            seek(0)
            post({ type: "play" })
          } else {
            // Without loop the runtime really stopped: the transport needs to know,
            // otherwise it would stay "playing" forever.
            stopClock()
          }
        }
        return
      }
      if (msg.type === "error") {
        setRuntimeError({ message: msg.message, stack: msg.stack })
        return
      }
      setFailedFonts(msg.failedFonts)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [post, seek, stopClock])

  // ---------------------------------------------------------------- reload
  const reload = useCallback(() => {
    restoreRef.current = frameRef.current
    // The new page is born stopped: the transport cannot keep saying
    // "playing" while nobody sends any frame.
    stopClock()
    setRuntimeError(null)
    setLoadError(null)
    setFailedFonts([])
    setReloads((n) => n + 1)
  }, [stopClock])

  // A prop changed (after the person stopped typing): the page is loaded again with the new values, going
  // back to the same frame — the same path as a reload, so the transport and the errors reset alike.
  const appliedRef = useRef(appliedKey)
  useEffect(() => {
    if (appliedRef.current === appliedKey) return
    appliedRef.current = appliedKey
    reload()
  }, [appliedKey, reload])

  // The agent rewrote the file (main fs.watch): it reloads going back to the
  // same frame, which is what allows comparing the before and the after of the adjustment.
  useEffect(() => {
    if (!motionId) return
    return motionApi.onChanged((payload) => {
      if (payload.id === motionId) reload()
    })
  }, [motionId, reload])

  // Without "ready" in time, the page is not going to answer: it asks the scheme what
  // happened (the same URL, through fetch — the scheme accepts CORS) and shows the reason,
  // instead of leaving the stage spinning forever.
  useEffect(() => {
    if (!src) return
    loadedRef.current = false
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (loadedRef.current) return
      void fetch(src)
        .then(async (res) => {
          if (cancelled) return
          if (!res.ok) {
            const text = (await res.text().catch(() => "")).trim().slice(0, 120)
            setLoadError(t("motion.loadFailedHttp", { status: res.status, text: text || res.statusText }))
          } else {
            setLoadError(t("motion.loadTimeout", { seconds: LOAD_TIMEOUT_MS / 1000 }))
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
        })
    }, LOAD_TIMEOUT_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [src, t])

  // --------------------------------------------------------------- layers
  // On every new page (load, live reload) the layers are measured again:
  // the agent has just changed when something enters or leaves. The old tracks stay
  // on screen while the new measurement runs — without blinking on every save.
  useEffect(() => {
    if (!motionId || readyCount === 0) return
    let cancelled = false
    setLayers((prev) => ({
      status: "loading",
      previous: prev.status === "ready" ? prev.layers : prev.status === "loading" ? prev.previous : [],
    }))
    const timer = window.setTimeout(() => {
      motionApi
        .layers(motionId)
        .then((result) => {
          if (cancelled) return
          setLayers({ status: "ready", layers: result.layers })
          // The soundtrack comes in the same measurement. It is only swapped when the composition
          // ANSWERED: during the "measuring" the audio of the previous version stays on
          // screen, like the layer tracks.
          setAudio(result.audio)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err)
          setLayers({ status: "error", message })
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [motionId, readyCount])

  // The selected layer disappeared from the composition (the agent removed or renamed it).
  useEffect(() => {
    // A sound track also has a name and is NOT a layer: without the caveat, the selected
    // sound would be unmarked in the same instant it was clicked.
    if (
      selectedName &&
      !selectedAudio &&
      layers.status === "ready" &&
      !layers.layers.some((l) => l.name === selectedName)
    ) {
      setSelectedName(null)
    }
  }, [layers, selectedName, selectedAudio])

  /**
   * The highlight of whoever is selected lives in the PREVIEW, not here: the stage is a
   * sandbox without same-origin, so what outlines the element is the runtime, at our
   * request. And the address is the INDEX in the page walk, not the label — two
   * elements may be called ".caption".
   *
   * It resends when the layer list changes: a save remounts the iframe, and the
   * new document knows no highlight at all. `index: -1` is "remove the highlight".
   */
  useEffect(() => {
    const layer = layers.status === "ready" ? layers.layers.find((l) => l.name === selectedName) : undefined
    post(layer ? { type: "highlight", index: layer.index, name: layer.name } : { type: "highlight", index: -1, name: null })
  }, [selectedName, layers, post])

  // ------------------------------------------------------------- shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // Typing in the chat (or in any field) cannot touch the playhead.
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return
      // The tab needs to be visible: with another tab on top, the arrows belong to another one.
      if (!rootRef.current || rootRef.current.offsetParent === null) return
      if (e.key === " ") {
        e.preventDefault()
        togglePlay()
      } else if (e.key === "ArrowLeft") {
        // ONE SECOND per arrow; with Shift, one frame — the fine adjustment keeps
        // existing, it just stopped being the default gesture.
        e.preventDefault()
        stepFrames(e.shiftKey ? -1 : -fps)
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        stepFrames(e.shiftKey ? 1 : fps)
      } else if (e.key === "Home") {
        e.preventDefault()
        jump(0)
      } else if (e.key === "End") {
        e.preventDefault()
        jump(Math.max(0, total - 1))
      } else if (e.key === "Escape" && fullscreen) {
        setFullscreen(false)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [togglePlay, stepFrames, jump, fps, total, fullscreen])

  // ---------------------------------------------------------------- stage
  // The stage stays at the TOP, in the native proportion of the composition: it takes the width of the
  // panel and, in a vertical piece or in a short panel, stops at a fraction of the
  // height — the rest belongs to the timeline, and no black band is left around it.
  useEffect(() => {
    const wrap = stageWrapRef.current
    const root = rootRef.current
    if (!wrap || !root) return
    const update = () => {
      const width = wrap.clientWidth
      const height = root.clientHeight
      if (width <= 0 || height <= 0) return
      // The tab got shorter than the split the person chose: the stage gives back the room
      // (otherwise it would push the timeline out of the panel).
      const room = Math.max(120, height - 180)
      if (timelineOpen && stageHeight !== null && !stageDragging.current && stageHeight > room) {
        setStageHeight(room)
        return
      }
      // Without the timeline the wrapper itself takes the leftover height; with it open,
      // once the divider is dragged, the room is what the wrapper has (minus the `pt-3`) —
      // the stage fills it instead of a fraction of the panel.
      const maxHeight =
        !timelineOpen || stageDragging.current || stageHeight !== null
          ? Math.max(120, wrap.clientHeight - 12)
          : Math.max(140, height * (fullscreen ? STAGE_MAX_RATIO_FULLSCREEN : STAGE_MAX_RATIO))
      const scale = Math.min(width / layout.width, maxHeight / layout.height)
      setBox({
        width: Math.max(1, Math.floor(layout.width * scale)),
        height: Math.max(1, Math.floor(layout.height * scale)),
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(wrap)
    observer.observe(root)
    return () => observer.disconnect()
  }, [layout.width, layout.height, fullscreen, stageHeight, timelineOpen])

  // --------------------------------------------------------------- ruler
  const dragging = useRef(false)

  const frameAt = useCallback((clientX: number) => {
    const el = trackRef.current
    const count = specRef.current.durationInFrames
    if (!el || count <= 0) return 0
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return Math.round(ratio * (count - 1))
  }, [])

  const onTrackDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (specRef.current.durationInFrames <= 0) return
      e.preventDefault()
      // Dragging is inspecting: it pauses first, otherwise the runtime play
      // would overwrite the seek on the next frame.
      if (playingRef.current) pause()
      dragging.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      seek(frameAt(e.clientX))
    },
    [frameAt, pause, seek],
  )

  const onTrackMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      seek(frameAt(e.clientX))
    },
    [frameAt, seek],
  )

  const onTrackUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }, [])

  // -------------------------------------------------------------- render
  useEffect(() => {
    if (!motionId) return
    return motionApi.onProgress((payload) => {
      if (payload.id !== motionId) return
      setRender((prev) =>
        prev.status === "running" ? { status: "running", frame: payload.frame, total: payload.total } : prev,
      )
    })
  }, [motionId])

  // The render state becomes three simple values: the handler does not depend on the
  // whole object and the JSX does not need to narrow the union on every use.
  const rendering = render.status === "running"
  const renderTotal = render.status === "running" ? render.total : 0
  const renderedPath = render.status === "done" ? render.path : null
  const renderError = render.status === "error" ? render.message : null
  const renderPercent = rendering && renderTotal > 0 ? Math.round((render.frame / renderTotal) * 100) : 0

  /** The modal is the last stop before the file exists: the choices come from it. */
  const onRender = useCallback(
    (options: MotionRenderOptions) => {
      if (!motionId || rendering) return
      setRenderOpen(false)
      setRender({ status: "running", frame: 0, total: 0 })
      motionApi
        .render(motionId, { ...options, ...(changedCount(form.overrides) ? { props: form.overrides } : {}) })
        .then((result) => {
          // The render starts with a system save dialog: cancelling is not
          // a failure, it is the person giving up — the tab goes back to rest.
          if ("canceled" in result) {
            setRender({ status: "idle" })
            return
          }
          setRender({ status: "done", path: result.path, ...(result.audioPath ? { audioPath: result.audioPath } : {}) })
        })
        .catch((err: unknown) =>
          setRender({ status: "error", message: err instanceof Error ? err.message : String(err) }),
        )
    },
    [motionId, rendering, form.overrides],
  )

  /**
   * "Save project": the whole piece in a .zip — HTML, media, fonts, audio.json
   * and the orbit.json manifest. It is what the composer recognizes when the file is
   * dragged back in another conversation (see motion-project in the main process).
   */
  const saveProject = useCallback(() => {
    if (!motionId || project.status === "saving") return
    setProject({ status: "saving" })
    motionApi
      .exportProject(motionId)
      .then((result) => {
        if (result.ok) setProject({ status: "done", path: result.path, files: result.files })
        else if (result.canceled) setProject({ status: "idle" })
        else setProject({ status: "error", message: result.error ?? t("motion.error") })
      })
      .catch((err: unknown) =>
        setProject({ status: "error", message: err instanceof Error ? err.message : String(err) }),
      )
  }, [motionId, project.status, t])

  const reveal = useCallback((target: string) => {
    // Same channel as the other points of the app (file-viewer, video-part, task-modal):
    // opening the system folder with the file already selected.
    void window.ipcRenderer.invoke("shell:showItemInFolder", target)
  }, [])

  if (!motionId) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {t("motion.unavailable")}
      </div>
    )
  }

  const pct = (f: number) => (total > 1 ? (f / (total - 1)) * 100 : 0)
  const position = pct(frame)
  const seconds = total / fps
  const step = rulerStep(seconds)
  const marks = total > 0 ? Array.from({ length: Math.floor(seconds / step) + 1 }, (_, i) => i * step) : []
  // What the modal promises of cost: the chosen fps changes the number of captured
  // frames (the duration in seconds is the same), and it is that number that hurts.
  const renderFps = renderOptions.fps > 0 ? renderOptions.fps : fps
  const renderFrames = fps > 0 ? Math.round((total / fps) * renderFps) : 0
  // The name column grew to fit the type ICON and the mark button without
  // squeezing the name. It is ONE width, used by the ruler, by the audio tracks and
  // by the layers: it is what keeps the three on the same scale (playhead included).
  const nameColumn = fullscreen ? "w-44" : "w-32"
  const failed = loadError

  /**
   * Divider above the timeline. Dragging DOWN gives room to the stage; dragging UP gives it
   * to the layers/timeline — the timeline keeps taking what is left. Double click undoes it.
   */
  const startStageResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const wrap = stageWrapRef.current
    const root = rootRef.current
    if (!wrap || !root || e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    stageDragging.current = true
    const startY = e.clientY
    const startHeight = wrap.getBoundingClientRect().height
    // The timeline never disappears: the stage stops with enough room left for it.
    const max = Math.max(160, root.clientHeight - 180)
    const heightAt = (clientY: number) => Math.round(Math.min(max, Math.max(120, startHeight + (clientY - startY))))
    const onMove = (ev: PointerEvent) => {
      // Straight into the style: the effect above measures the wrapper and refits the stage.
      wrap.style.height = `${heightAt(ev.clientY)}px`
    }
    const onEnd = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", onMove)
      handle.removeEventListener("pointerup", onEnd)
      handle.removeEventListener("pointercancel", onEnd)
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId)
      document.body.style.cursor = ""
      stageDragging.current = false
      const size = heightAt(ev.clientY)
      setStageHeight(size)
      writeStageHeight(size)
    }
    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onEnd)
    handle.addEventListener("pointercancel", onEnd)
    document.body.style.cursor = "row-resize"
  }

  return (
    // In fullscreen the SAME node becomes the fixed overlay (like the panel browser):
    // the iframe is not remounted, so the playhead and the bridge survive.
    <div
      ref={rootRef}
      className={cn(
        // `bg-sidebar`, the same as the other panel tabs (the terminal and the browser
        // use it): with `bg-background` the tab clashed with the rest and the header
        // looked glued to the tab strip.
        "group/motion flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar",
        fullscreen && FULLSCREEN_OVERLAY_CLASS,
      )}
    >
      {/* Header: composition + file on the left; reload, fullscreen and
          render on the right. Same breathing room as the browser header (p-2). */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 p-2">
        <div className="flex min-w-0 items-center gap-2">
          <Clapperboard className="size-3.5 shrink-0 text-muted-foreground" />
          <Truncate text={title}>
            <span className="truncate text-xs font-medium text-muted-foreground">{title}</span>
          </Truncate>
          {entry && (
            <Truncate>
                <Badge variant="outline" className="max-w-44 shrink-0 truncate font-mono" title={path ?? entry}>
                {baseName(entry)}
              </Badge>
            </Truncate>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {/* Only a piece that declares props has this: the form of props.json. The dot says that
              something differs from the defaults. */}
          {propsInfo?.exists && (
            <span className="relative">
              <IconAction
                icon={SlidersHorizontal}
                label={t("motion.propsTitle")}
                onClick={() => setPropsOpen((v) => !v)}
              />
              {changedCount(form.overrides) > 0 && (
                <span className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />
              )}
            </span>
          )}
          <IconAction
            icon={project.status === "saving" ? Loader2 : Download}
            label={t("motion.saveProject")}
            onClick={saveProject}
            disabled={project.status === "saving"}
          />
          <IconAction icon={RotateCw} label={t("motion.reload")} onClick={reload} />
          {/* The same card as the Design tab's: closed, only the stage is left — the icon
              points DOWN, the side the timeline card comes from. */}
          <IconAction
            icon={timelineOpen ? PanelBottomClose : PanelBottomOpen}
            label={t(timelineOpen ? "motion.hideLayers" : "motion.showLayers")}
            onClick={() => setTimelineOpen((v) => !v)}
          />
          <IconAction
            icon={fullscreen ? Minimize2 : Maximize2}
            label={t(fullscreen ? "motion.exitFullscreen" : "motion.fullscreen")}
            onClick={() => setFullscreen((v) => !v)}
          />
          {/* Render opens the MODAL: format, size, fps and separate audio are
              decided before paying the capture minutes. While it renders the
              button stays disabled and becomes the progress indicator itself. */}
          <Hint label={t("motion.renderOptions")}>
            <Button
              variant="default"
              size="lg"
              className="ml-1 gap-1.5"
              disabled={rendering || total <= 0}
              onClick={() => setRenderOpen(true)}
            >
       
               {rendering ? <Loader2 className="size-3.5 animate-spin" /> : <Film className="size-3.5" />}
            {rendering && renderTotal > 0 ? t("motion.rendering", { percent: renderPercent }) : t("motion.render")}
          </Button>
          </Hint>
        </div>
      </div>

      {/* Thin line of the render progress — the button state says the number. */}
      {rendering && (
        <div className="h-0.5 shrink-0 bg-muted">
          <div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${renderPercent}%` }} />
        </div>
      )}

      {/* Render feedback: the SAME side breathing room as the stage (px-3). The `Alert`
          is born with `w-full` — with a side margin it measured 100% + 2×margin and
          overflowed the panel exactly by that margin; the panel's `overflow-hidden`
          then cut the right border and the X. What gives the breathing room is the
          container, not the card. */}
      {project.status === "done" && (
        <div className="shrink-0 px-3 pt-2">
          <Alert>
            <Download className="text-emerald-500" />
            <AlertTitle>{t("motion.projectSaved", { path: baseName(project.path) })}</AlertTitle>
            <AlertDescription className="break-words">
              {t("motion.projectSavedHint")}
            </AlertDescription>
            <AlertAction>
              <Hint label={project.path}>
                <Button variant="outline" size="sm" onClick={() => reveal(project.path)} >
       
                       {t("motion.showInFolder")}
              </Button>
              </Hint>
              <IconAction icon={X} label={t("motion.dismiss")} onClick={() => setProject({ status: "idle" })} />
            </AlertAction>
          </Alert>
        </div>
      )}

      {project.status === "error" && (
        <div className="shrink-0 px-3 pt-2">
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{t("motion.saveProjectFailed")}</AlertTitle>
            <AlertDescription className="break-words">{project.message}</AlertDescription>
            <AlertAction>
              <IconAction icon={X} label={t("motion.dismiss")} onClick={() => setProject({ status: "idle" })} />
            </AlertAction>
          </Alert>
        </div>
      )}

      {renderedPath && (
        <div className="shrink-0 px-3 pt-2">
          <Alert>
            <CircleCheck className="text-emerald-500" />
            <AlertTitle>{t("motion.rendered", { file: baseName(renderedPath) })}</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              <Hint label={renderedPath}>
                <Button variant="outline" size="sm" onClick={() => reveal(renderedPath)} >
       
                       {t("motion.showInFolder")}
              </Button>
              </Hint>
              {/* It asked for separate audio: the WAV is next to the video, and the button
                  leads straight to it (the folder is already open from the other one). */}
              {render.status === "done" && render.audioPath && (
                <Hint label={render.audioPath}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => reveal(render.audioPath!)}
                  >
       
                           <Music className="size-3" />
                  {baseName(render.audioPath)}
                </Button>
                </Hint>
              )}
            </AlertDescription>
            <AlertAction>
              <IconAction icon={X} label={t("motion.dismiss")} onClick={() => setRender({ status: "idle" })} />
            </AlertAction>
          </Alert>
        </div>
      )}

      {renderError && (
        <div className="shrink-0 px-3 pt-2">
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{t("motion.renderFailed")}</AlertTitle>
            <AlertDescription className="break-words">{renderError}</AlertDescription>
            <AlertAction>
              <IconAction icon={X} label={t("motion.dismiss")} onClick={() => setRender({ status: "idle" })} />
            </AlertAction>
          </Alert>
        </div>
      )}

      {failedFonts.length > 0 && (
        <div className="shrink-0 px-3 pt-2">
          <Alert>
            <AlertTriangle className="text-amber-500" />
            <AlertTitle>{t("motion.fontsFailed")}</AlertTitle>
            <AlertDescription className="break-words">{failedFonts.join(", ")}</AlertDescription>
          </Alert>
        </div>
      )}

      {/* The props form: above the stage, only when the piece declares props. A broken props.json is
          said here too, instead of the piece silently having no form. */}
      {propsInfo?.exists && propsInfo.errors.length > 0 && (
        <div className="shrink-0 px-3 pt-2">
          <Alert>
            <AlertTriangle className="text-amber-500" />
            <AlertTitle>{t("motion.propsBroken", { errors: propsInfo.errors.join("; ") })}</AlertTitle>
          </Alert>
        </div>
      )}
      {propsOpen && propsSchema && (
        <div className="shrink-0 px-3 pt-2">
          <MotionPropsForm
            schema={propsSchema}
            values={propValues}
            errors={form.errors}
            changed={changedCount(form.overrides)}
            onChange={(name, value) => setPropValues((prev) => ({ ...prev, [name]: value }))}
            onReset={() => setPropValues(defaultValues(propsSchema))}
          />
        </div>
      )}

      {/* Stage at the top: the composition in the native proportion, with no black band
          around it — what is left of the height belongs to the timeline. */}
      <div
        ref={stageWrapRef}
        className={cn(
          "flex items-center justify-center px-3 pt-3",
          // Closed timeline: the stage is the whole tab and centers itself in the leftover.
          timelineOpen ? "shrink-0" : "min-h-0 flex-1",
        )}
        style={timelineOpen && stageHeight !== null ? { height: stageHeight } : undefined}
      >
        {/* The stage is only the WINDOW: what carries the size of the piece is the iframe.
            `maxWidth` keeps the iframe still unscaled (the document has the declared
            size) from overflowing the panel on the first frame. */}
        <div
          className="relative overflow-hidden rounded-md bg-black ring-1 ring-border/60"
          style={{ width: box.width || undefined, height: box.height || 160, maxWidth: "100%" }}
        >
          <iframe
            ref={iframeRef}
            // Remounts the iframe (a real reload): the composition URL does not change
            // when the file is rewritten in place.
            key={`${motionId}:${reloads}`}
            src={src}
            title={title}
            // WITHOUT allow-same-origin on purpose: `allow-scripts` + same-origin
            // would let the composition remove its own sandbox.
            sandbox="allow-scripts"
            allow=""
            referrerPolicy="no-referrer"
            // The composition is a document of the DECLARED SIZE (the guide tells
            // html/body to be 1920x1080), not a page that adapts to the stage. The
            // iframe receives the REAL size — it is what defines the internal viewport
            // the composition reads, the same as the capture window of the render — and only
            // the `scale` shrinks it to fit the stage. With `h-full w-full` the
            // document overflowed and the stage showed the top left corner.
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${box.width > 0 ? box.width / layout.width : 1})`,
              transformOrigin: "top left",
            }}
            // `pointer-events-none`: the stage is only IMAGE. Without this, a click on it
            // gave the keyboard focus to the iframe and space/arrows stopped reaching
            // the app — the shortcut existed and did not answer, which is worse than not having it.
            className={cn("pointer-events-none border-0 bg-transparent", !spec && "invisible")}
          />
          {!spec && !runtimeError && !failed && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-muted/30 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("motion.loading")}
            </div>
          )}
          {/* It did not load: the reason in place of the spinning screen, and the way out. */}
          {failed && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted/40 p-3 text-center">
              <AlertTriangle className="size-4 text-destructive" />
              <span className="text-xs font-medium">{t("motion.loadFailed")}</span>
              <span className="max-w-full break-words text-[11px] text-muted-foreground">{failed}</span>
              <Button variant="outline" size="sm" onClick={reload}>
                {t("motion.retry")}
              </Button>
            </div>
          )}
          {/* Broken composition: the notice in place of the empty black screen (the iframe
              stays alive behind — reloading is the way out). */}
          {runtimeError && (
            <div className="absolute inset-0 flex items-start justify-center overflow-auto bg-black/85 p-3">
              <Alert variant="destructive" className="max-w-lg">
                <AlertTriangle />
                <AlertTitle>{t("motion.error")}</AlertTitle>
                <AlertDescription className="break-words">{runtimeError.message}</AlertDescription>
                {runtimeError.stack && (
                  <pre className="col-span-2 mt-1 max-h-40 overflow-auto text-[10px] whitespace-pre-wrap text-muted-foreground">
                    {runtimeError.stack}
                  </pre>
                )}
              </Alert>
            </div>
          )}
        </div>
      </div>

      {/* Metadata: position / duration (one counter, not two loose times) and the
          format. The measured fps only appears WHILE PLAYING — stopped, an fps number on
          screen says nothing and even looked like the piece was 30 when it is not. */}
      <div className="flex shrink-0 items-center gap-x-3 px-3 pt-2 text-[10px] tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground">
          {motionTimecode(frame, fps)}
          <span className="font-normal text-muted-foreground/70">
            {" / "}
            {motionTimecode(Math.max(0, total - 1), fps)}
          </span>
        </span>
        <span>
          {layout.width}×{layout.height}
        </span>
        <span className="ml-auto" title={t("motion.measuredFpsHint")}>
          {playing && measuredFps != null ? t("motion.measuredFps", { fps: measuredFps }) : ""}
        </span>
      </div>

      {/* Transport: repeat on the left, start/play/end in the middle and comment the
          instant on the right — the two extremes are actions over what one sees. */}
      <div className="flex shrink-0 items-center justify-between gap-2 px-2.5 py-1">
        <Hint label={t("motion.loop")}>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(loop && "bg-primary/15 text-primary hover:bg-primary/20")}
            aria-pressed={loop}

            aria-label={t("motion.loop")}
            onClick={toggleLoop}
          >
            <Repeat className="size-3.5" />
          </Button>
        </Hint>
        <div className="flex items-center gap-0.5">
          <Hint label={t("motion.toStart")}>
            <Button
              variant="ghost"
              size="icon"
              disabled={total <= 0}

              aria-label={t("motion.toStart")}
              onClick={() => jump(0)}
            >
              <SkipBack className="size-3.5" />
            </Button>
          </Hint>
          <Button
            variant={playing ? "secondary" : "default"}
            size="icon"
            disabled={total <= 0}
            aria-label={t(playing ? "motion.pause" : "motion.play")}
            onClick={togglePlay}
          >
            {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </Button>
          <Hint label={t("motion.toEnd")}>
            <Button
              variant="ghost"
              size="icon"
              disabled={total <= 0}

              aria-label={t("motion.toEnd")}
              onClick={() => jump(Math.max(0, total - 1))}
            >
              <SkipForward className="size-3.5" />
            </Button>
          </Hint>
        </div>
        <Hint label={t("motion.commentHint")}>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!entry || total <= 0}

            aria-label={t("motion.commentHint")}
            onClick={() => comment()}
          >
            <MessageSquarePlus className="size-3.5" />
          </Button>
        </Hint>
      </div>

      {/* Timeline: ruler + one track per layer, with the same scale and the
          same playhead. Clicking or dragging anywhere seeks the frame;
          clicking the name selects the layer for the chat note. */}
      {/* The card's edge: dragging it decides how much of the tab the stage and the
          timeline each get. Double click hands the stage back to the panel's rule. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("motion.resizeTimeline")}
        title={t("motion.resizeTimeline")}
        onPointerDown={startStageResize}
        onDoubleClick={() => {
          setStageHeight(null)
          writeStageHeight(null)
        }}
        className={cn(
          "group/timeline h-1.5 w-full shrink-0 cursor-row-resize touch-none items-center justify-center border-t border-border/60",
          timelineOpen ? "flex" : "hidden",
        )}
      >
        <div className="h-0.5 w-8 rounded-full bg-transparent transition-colors group-hover/timeline:bg-primary/60" />
      </div>
      <div className={cn("min-h-0 flex-col", timelineOpen ? "flex flex-1" : "hidden")}>
        {/* The ruler lives INSIDE the scrollable area, stuck to the top. Outside it, the
            ruler width did not match the width of the rows as soon as the scroll
            bar appeared (it takes 6px — see `*::-webkit-scrollbar`), and the
            playhead went out of place in relation to the layers. Here ruler and rows have
            the same width by construction; the opaque background is what lets the rows
            pass underneath. */}
        <div className="relative min-h-0 flex-1 overflow-y-auto pb-2">
          <div className="sticky top-0 z-10 flex items-center bg-sidebar">
            <div className={cn("flex shrink-0 items-center gap-1.5 px-3 text-[10px] font-medium text-muted-foreground", nameColumn)}>
            <Layers className="size-3" />
            {t("motion.layers")}
          </div>
          <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-label={t("motion.timeline")}
            aria-valuemin={0}
            aria-valuemax={Math.max(0, total - 1)}
            aria-valuenow={frame}
            onPointerDown={onTrackDown}
            onPointerMove={onTrackMove}
            onPointerUp={onTrackUp}
            onPointerCancel={onTrackUp}
            className={cn(
              "relative mr-3 h-6 flex-1 touch-none select-none",
              total > 0 ? "cursor-pointer" : "opacity-50",
            )}
          >
            {marks.map((s) => (
              <div key={s} className="absolute inset-y-0" style={{ left: `${pct(s * fps)}%` }}>
                <div className="absolute bottom-0 h-1.5 w-px bg-border" />
                <span className="absolute top-0.5 left-1 text-[9px] tabular-nums text-muted-foreground">{s}s</span>
              </div>
            ))}
            <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-primary" style={{ left: `${position}%` }} />
          </div>
        </div>
          {/* The sound of the piece plays OUTSIDE the iframe (the stage is a sandbox: no autoplay,
              no control of its own), so the elements live here — invisible —
              and what commands them is the transport, through the effect above. One per track, in
              the manifest order: it is the index that matches the element with the track. */}
          {audioTracks.map((track, index) => (
            <audio
              key={`audio-${track.name}-${index}`}
              ref={(el) => {
                audioRefs.current[index] = el
              }}
              src={audioSrc(track.url) ?? undefined}
              preload="auto"
              onLoadedMetadata={(e) => measureAudio(track.url, e.currentTarget)}
            />
          ))}
          {/* Each track is a ROW, drawn where it plays: the ruler is the whole
              piece, so `start`/`end` become position and length — one can see
              the music bed, the one-off effect and the narration at once. Without `url`
              the audio is OUTSIDE the composition folder: it goes in the rendered file,
              but the scheme does not serve it and the preview stays mute. */}
          {audioTracks.map((track, index) => {
            const seconds = total / fps
            const at = frame / fps
            const from = seconds > 0 ? Math.min(100, Math.max(0, (track.start / seconds) * 100)) : 0
            // Without `end` in the manifest the bar stretched to the right edge; now it
            // ends where the file really has sound (see motionTrackEnd).
            const end = motionTrackEnd(track, trackDuration(track)) ?? seconds
            const to = seconds > 0 ? Math.min(100, Math.max(from, (end / seconds) * 100)) : 100
            const live = playing && track.url !== null && motionTrackIsLive(track, trackDuration(track), at)
            const selected = selectedName === track.name
            const markedAudio = quoteAudio === track.name
            return (
              <div
                key={`track-${track.name}-${index}`}
                className={cn("group/audio flex h-6 items-center", selected && "bg-primary/10")}
                title={t(track.url ? "motion.audioHint" : "motion.audioOutside")}
              >
                <Truncate>
                  <div
                  className={cn(
                    "flex h-full min-w-0 shrink-0 items-center gap-1.5 truncate px-3 text-[11px] transition-colors",
                    nameColumn,
                    selected
                      ? "font-medium text-foreground"
                      : live
                        ? "text-foreground/90"
                        : "text-muted-foreground",
                  )}
                >
                  <Hint label={t("motion.audioSelect", { name: track.name })}>
                    <button
                      type="button"
                      onClick={() => setSelectedName(selected ? null : track.name)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
       
                               <span
                      className={cn("size-1.5 shrink-0 rounded-full", live ? "bg-emerald-500" : "bg-muted-foreground/30")}
                    />
                    {/* The SOUND icon also in this row: the track is not a DOM
                        element (it plays outside the stage), but it is of the same type as a
                        composition audio layer — the drawing says that without
                        needing a word. */}
                    <Music className="size-3 shrink-0 opacity-70" />
                    <span className="truncate italic">{track.name}</span>
                  </button>
                  </Hint>
                  {/* Mark the TRACK, as one marks the layer — but in `audio`: the
                      agent needs to know it is sound, otherwise it looks in the stage for an
                      element with the name of the soundtrack. */}
                  <Hint label={t("motion.audioMarkHint", { name: track.name })}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedName(track.name)
                        comment({ audio: track.name })
                      }}
                      aria-label={t("motion.audioMarkHint", { name: track.name })}
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded transition-opacity cursor-pointer",
                        markedAudio
                          ? "text-primary opacity-100"
                          : "text-muted-foreground opacity-0 group-hover/audio:opacity-100",
                      )}
                    >
                      <MessageSquarePlus className="size-3" />
                    </button>
                  </Hint>
                </div>
                </Truncate>
                <div className="relative mr-3 h-full flex-1">
                  <div
                    className={cn(
                      "absolute inset-y-1 rounded-sm",
                      track.url ? "bg-primary/20" : "bg-muted-foreground/20",
                    )}
                    style={{ left: `${from}%`, width: `${Math.max(0.5, to - from)}%` }}
                  />
                  <div
                    className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-primary/70"
                    style={{ left: `${position}%` }}
                  />
                </div>
              </div>
            )
          })}
          {audio?.error && (
            <p className="px-3 py-2 text-[11px] text-amber-500">{t("motion.audioFailed", { error: audio.error })}</p>
          )}
          {layers.status === "loading" && layers.previous.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {t("motion.layersLoading")}
            </div>
          )}
          {layers.status === "error" && spec && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">{t("motion.layersFailed", { error: layers.message })}</p>
          )}
          {layers.status === "ready" && layers.layers.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">{t("motion.layersEmpty")}</p>
          )}
          {layerList.map((layer, index) => {
            const selected = selectedName === layer.name
            const visible = onScreenAt(layer, frame)
            const marked = quoteLayer === layer.name
            const first = layer.spans[0]
            const last = layer.spans[layer.spans.length - 1]
            const KindIcon = LAYER_ICON[layer.kind] ?? Box
            const mark = () => {
              setSelectedName(layer.name)
              comment({ layer: layer.name })
            }
            return (
              <div
                key={`${layer.name}-${index}`}
                className={cn("group/layer flex h-6 items-center", selected && "bg-primary/10")}
              >
                <Truncate>
                  <div
                  className={cn(
                    "flex h-full min-w-0 shrink-0 items-center gap-1.5 truncate px-3 text-[11px] transition-colors",
                    nameColumn,
                    selected ? "font-medium text-foreground" : visible ? "text-foreground/90" : "text-muted-foreground",
                  )}
                >
                  <Hint label={t("motion.layerSelect", { name: layer.name })}>
                    <button
                      type="button"
                      onClick={() => setSelectedName(selected ? null : layer.name)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
       
                               <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        visible ? "bg-emerald-500" : "bg-muted-foreground/30",
                      )}
                    />
                    {/* The `title` goes in the wrapper: the lucide icon does not accept the
                        attribute, and the type name has to be one hover away. */}
                    <span className="flex shrink-0" title={t(`motion.kind.${layer.kind}`)}>
                      <KindIcon className="size-3 opacity-70" />
                    </span>
                    <span className={cn("truncate", !layer.named && "italic")}>{layer.name}</span>
                  </button>
                  </Hint>
                  {/* Mark: pins THIS layer — and the frame of now — to the next
                      chat message. It appears on hover and stays lit when it is the
                      marked one: in forty tracks, an always visible button is noise. */}
                  <Hint label={t("motion.layerMarkHint", { name: layer.name })}>
                    <button
                      type="button"
                      onClick={mark}
                      aria-label={t("motion.layerMarkHint", { name: layer.name })}
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded transition-opacity cursor-pointer",
                        marked
                          ? "text-primary opacity-100"
                          : "text-muted-foreground opacity-0 group-hover/layer:opacity-100",
                      )}
                    >
                      <MessageSquarePlus className="size-3" />
                    </button>
                  </Hint>
                </div>
                </Truncate>
                <div
                  className="relative mr-3 h-full flex-1 cursor-pointer touch-none select-none"
                  onPointerDown={onTrackDown}
                  onPointerMove={onTrackMove}
                  onPointerUp={onTrackUp}
                  onPointerCancel={onTrackUp}
                  title={
                    first && last
                      ? t("motion.layerSpan", {
                          name: layer.name,
                          from: motionTimecode(first[0], fps),
                          to: motionTimecode(last[1], fps),
                        })
                      : layer.name
                  }
                >
                  {layer.spans.map(([a, b]) => (
                    <div
                      key={`${a}-${b}`}
                      // Clicking the BAR itself selects the layer — and the event
                      // goes on to the track, which repositions the playhead: the two
                      // gestures ask for the same thing ("go there and show me who
                      // it is"). There is no need to stop the propagation; this one arrives first,
                      // the track one right after.
                      onPointerDown={() => setSelectedName(layer.name)}
                      className={cn(
                        "absolute inset-y-1 rounded-sm",
                        selected ? "bg-primary" : layer.named ? "bg-primary/45" : "bg-muted-foreground/35",
                      )}
                      style={{ left: `${pct(a)}%`, width: `max(2px, ${pct(b) - pct(a)}%)` }}
                    />
                  ))}
                  <div
                    className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-primary/70"
                    style={{ left: `${position}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {/* Fullscreen: conversation on the left, agent actions on the right and composer
          below — collapsed at the edge, they open on hover or pinned, the same as the
          browser. */}
      {fullscreen && (
        <FullscreenChatFeed sessionId={sessionId} pinned={chatPinned} onTogglePin={() => setChatPinned((v) => !v)} />
      )}
      {fullscreen && (
        <ActionsFeed
          sessionId={sessionId}
          pinned={actionsPinned}
          onTogglePin={() => setActionsPinned((v) => !v)}
          icon={Sparkles}
          title={t("fullscreen.agentActions")}
        />
      )}
      {fullscreen && (
        <FullscreenComposer
          sessionId={sessionId}
          pinned={composerPinned}
          onTogglePin={() => setComposerPinned((v) => !v)}
          onSent={() => setChatPinned(true)}
        />
      )}

      {/* The render modal: the four decisions that were left hidden in a menu
          (only the format) or fixed in the code (size, fps, audio). The "Render"
          here opens the system save dialog, as before. */}
      <Dialog open={renderOpen} onOpenChange={setRenderOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Film className="size-4" />
              {t("motion.renderOptions")}
            </DialogTitle>
            <DialogDescription>{t("motion.renderOptionsHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium">{t("motion.renderFormat")}</span>
              <SettingSelect
                value={renderOptions.format}
                onChange={(format) => setRenderOptions((o) => ({ ...o, format }))}
                options={RENDER_FORMATS.map((format) => ({ value: format.value, label: t(format.labelKey) }))}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium">{t("motion.renderQuality")}</span>
              <SettingSelect
                value={renderOptions.quality}
                onChange={(quality) => setRenderOptions((o) => ({ ...o, quality }))}
                options={[
                  { value: "high" as MotionRenderQuality, label: t("motion.qualityHigh") },
                  { value: "balanced" as MotionRenderQuality, label: t("motion.qualityBalanced") },
                  { value: "small" as MotionRenderQuality, label: t("motion.qualitySmall") },
                ]}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium">{t("motion.renderFps")}</span>
              <SettingSelect
                value={String(renderOptions.fps)}
                onChange={(value) => setRenderOptions((o) => ({ ...o, fps: Number(value) }))}
                options={[
                  { value: "0", label: t("motion.fpsComposition", { fps }) },
                  { value: "24", label: "24 fps" },
                  { value: "30", label: "30 fps" },
                  { value: "60", label: "60 fps" },
                ]}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium">{t("motion.separateAudio")}</p>
                <p className="text-[11px] leading-tight text-muted-foreground">{t("motion.separateAudioHint")}</p>
              </div>
              <Switch
                checked={renderOptions.separateAudio}
                onCheckedChange={(checked) => setRenderOptions((o) => ({ ...o, separateAudio: checked }))}
              />
            </div>
            {changedCount(form.overrides) > 0 && (
              <p className="text-[11px] leading-tight text-foreground">
                {t("motion.renderWithProps", { count: changedCount(form.overrides) })}
              </p>
            )}
            {Object.keys(form.errors).length > 0 && (
              <p className="text-[11px] leading-tight text-destructive">{t("motion.renderFixProps")}</p>
            )}
            <p className="text-[11px] leading-tight text-muted-foreground">
              {t("motion.renderCostHint", { frames: renderFrames })}
            </p>
          </div>
          <DialogFooter showCloseButton>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={Object.keys(form.errors).length > 0}
              onClick={() =>
                onRender({
                  format: renderOptions.format,
                  quality: renderOptions.quality,
                  separateAudio: renderOptions.separateAudio,
                  // 0 = "the composition one": it sends no fps at all.
                  ...(renderOptions.fps > 0 ? { fps: renderOptions.fps } : {}),
                })
              }
            >
              <Film className="size-3.5" />
              {t("motion.render")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
