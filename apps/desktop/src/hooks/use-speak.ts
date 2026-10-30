import i18n from "@/src/i18n"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { VoiceTtsEngine } from "@shared/voice"
import { parseVoiceStatus, type VoiceStatus } from "@/src/lib/dictation"
import { speechPieceText, spokenPrefix } from "@/src/lib/voice-call"
import { voiceApi } from "@/src/lib/voice-ipc"
import { useVoiceActivity } from "@/src/stores/voice-activity"

/**
 * SPEAK: asks main for the synthesis (`voice:tts:*`) and plays the PCM16 chunks
 * in sequence, splicing one onto the next.
 *
 * The audio arrives in streaming — each chunk is scheduled as an
 * AudioBufferSourceNode on the same AudioContext, with its start at the end of the
 * previous one. There is no <audio> and no blob per chunk: building a blob per chunk
 * would introduce an audible pause between them.
 */

/** Rate of the engine chunks (the same one main sends in `sr`). */
export const TTS_SAMPLE_RATE = 24000

/** Speech channels (`voice:tts:*`); `voice:status` comes from `voiceApi`. */
const CHANNEL = {
  start: "voice:tts:start",
  chunk: "voice:tts:chunk",
  done: "voice:tts:done",
  cancel: "voice:tts:cancel",
  streamStart: "voice:tts:stream-start",
  streamAppend: "voice:tts:stream-append",
  streamEnd: "voice:tts:stream-end",
  streamClear: "voice:tts:stream-clear",
} as const

/** Slack between chunks that arrive late and the scheduling itself. */
const SCHEDULE_LEAD_SECONDS = 0.02

/**
 * How long to wait, after the predicted end of the scheduled audio, for a `done`.
 *
 * The local engine can take MORE than real time to synthesize the next
 * sentence (RTF > 1 on machines without acceleration). Five seconds cut the
 * continuation in the middle: the first chunk played, the second was still being
 * generated, and the safety net ended the speech. It is a net for a lost
 * `done`, not a latency limit — the engine already has its own timeout.
 */
const DONE_GRACE_SECONDS = 60

/** Voice preferences (the `voice.tts` block of AppSettings) already resolved. */
export interface TtsPrefs {
  enabled: boolean
  voice: string
  lang: string
  speed: number
}

export interface SpeakRequest {
  voice?: string
  lang?: string
  speed?: number
  /** Audio priority for this speech; without it, the one from settings applies. */
  engine?: VoiceTtsEngine
}

/** What main sends in `voice:tts:chunk`. */
interface ChunkPayload {
  id?: string
  pcm?: string
  sr?: number
  i?: number
  n?: number
  /** Sentence number, only in continuous speech (call mode shows the one playing). */
  seg?: number
  /** Text of this audio chunk (the local engine sends it; the model route does not). */
  text?: string
}

/** What main sends in `voice:tts:done` (with `error` when the synthesis failed). */
interface DonePayload {
  id?: string
  error?: string
}

/**
 * Reads the `voice.tts` block defensively: the shared type may not
 * carry it yet (it arrives from another worker), and the UI cannot depend on that to
 * open. With nothing in localStorage, the app defaults apply.
 */
export function readTtsPrefs(voice: unknown): TtsPrefs {
  const tts = (voice as { tts?: Record<string, unknown> } | null | undefined)?.tts
  const text = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value : fallback
  return {
    enabled: typeof tts?.enabled === "boolean" ? tts.enabled : true,
    voice: text(tts?.voice, "F2"),
    lang: text(tts?.lang, "auto"),
    speed: typeof tts?.speed === "number" && tts.speed > 0 ? tts.speed : 1,
  }
}

/**
 * Audio priority from the `voice.tts` block: `model` (route through the provider, the
 * default) or `local` (Supertonic engine). A missing value or one outside the domain
 * falls back to the default — the speech never ends up without an engine.
 */
export function readTtsEngine(voice: unknown): VoiceTtsEngine {
  const engine = (voice as { tts?: { engine?: unknown } } | null | undefined)?.tts?.engine
  return engine === "local" ? "local" : "model"
}

/** base64 of PCM16LE -> Float32 samples in -1..1. Invalid input becomes empty. */
export function decodePcm16(pcm: string): Float32Array {
  let binary: string
  try {
    binary = atob(pcm)
  } catch {
    return new Float32Array(0)
  }
  const count = binary.length >> 1
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8)
    samples[i] = (value >= 0x8000 ? value - 0x10000 : value) / 32768
  }
  return samples
}

/** `voice:status` response reduced to what the button needs to know. */
export interface TtsStatus {
  ready: boolean
  /** `false` = nobody answered (old main or no engine) — does not block the button. */
  known: boolean
}

/**
 * Parses `voice:status` without trusting its shape: only `ttsReady` is required.
 *
 * With the priority on `model`, the provider route (`modelTts.available`) already
 * unlocks the button even without the local model on disk — that is the half the
 * preference added. Without a route, the local reading applies (the pipeline falls back to
 * the local engine, so that is what rules the button state).
 */
export function readTtsStatus(raw: unknown, engine: VoiceTtsEngine = "model"): TtsStatus {
  const status = raw as
    | {
        models?: Record<string, { installed?: boolean }>
        ttsReady?: boolean
        modelTts?: { available?: boolean }
      }
    | null
    | undefined
  const local = (): TtsStatus => {
    if (typeof status?.ttsReady === "boolean") return { ready: status.ttsReady, known: true }
    const models = status?.models
    if (models && typeof models === "object" && Object.keys(models).length > 0) {
      return { ready: Object.values(models).some((model) => model?.installed === true), known: true }
    }
    return { ready: true, known: false }
  }
  if (engine === "model" && status?.modelTts?.available === true) return { ready: true, known: true }
  return local()
}

function createAudioContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
  } catch {
    return new AudioContext()
  }
}

/** Asks main to drop the synthesis. Best-effort: without a channel, there is nothing to do. */
function cancelRequest(id: string) {
  const call = window.ipcRenderer?.invoke(CHANNEL.cancel, { id })
  void Promise.resolve(call).catch(() => {})
}

export type AudioContextFactory = () => AudioContext

/**
 * Playback queue: schedules the spliced chunks and keeps what is still
 * playing. Lives outside React (and receives the AudioContext factory from outside)
 * so it can be tested with a fake AudioContext — the hook only handles the
 * speech id and the lifecycle.
 */
export class ChunkPlayer {
  onEnded: (() => void) | null = null
  private readonly createContext: AudioContextFactory
  private context: AudioContext | null = null
  private sources: AudioBufferSourceNode[] = []
  /** Sentence (continuous speech) and end, on the context clock, of each scheduled chunk. */
  private meta = new Map<AudioBufferSourceNode, { seg?: number; end: number }>()
  /**
   * Chunks of each sentence with the text and the audio window: it is what allows
   * revealing the subtitle along with the sound. It stays outside `meta` because `meta` disappears
   * when the chunk ends — and the subtitle needs what has already played.
   */
  private pieces = new Map<number, { text: string; start: number; end: number }[]>()
  private nextAt = 0

  constructor(createContext: AudioContextFactory) {
    this.createContext = createContext
  }

  /** Creates the AudioContext on demand — in the click gesture, when possible. */
  ensure(): AudioContext {
    if (this.context && this.context.state !== "closed") return this.context
    this.context = this.createContext()
    return this.context
  }

  /** End of the audio already scheduled, on the context clock. */
  get scheduledEnd(): number {
    return this.nextAt
  }

  /** Context clock (0 if it does not even exist yet). */
  get clock(): number {
    return this.context?.currentTime ?? 0
  }

  /** Scheduled chunks that have not reached their end yet. */
  get pending(): number {
    return this.sources.length
  }

  /**
   * Schedules a chunk spliced onto the end of the previous one and returns in how many seconds
   * it starts playing. An empty chunk schedules nothing (returns `null`).
   */
  schedule(samples: Float32Array, sampleRate: number, seg?: number, text?: string): number | null {
    if (samples.length === 0) return null
    const context = this.ensure()
    if (context.state === "suspended") void context.resume()
    const buffer = context.createBuffer(1, samples.length, sampleRate)
    buffer.getChannelData(0).set(samples)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    // Splices onto the previous chunk; if playback fell behind, goes back to "now".
    const at = Math.max(this.nextAt, context.currentTime + SCHEDULE_LEAD_SECONDS)
    source.start(at)
    this.nextAt = at + buffer.duration
    this.sources.push(source)
    this.meta.set(source, { seg, end: this.nextAt })
    // Without text there is no subtitle for this chunk — but the previous one has already been said.
    if (typeof seg === "number" && text?.trim()) {
      const pieces = this.pieces.get(seg) ?? []
      pieces.push({ text: text.trim(), start: at, end: this.nextAt })
      this.pieces.set(seg, pieces)
    }
    source.onended = () => {
      this.sources = this.sources.filter((current) => current !== source)
      this.meta.delete(source)
      source.disconnect()
      this.onEnded?.()
    }
    return Math.max(0, at - context.currentTime)
  }

  /**
   * What has already played of sentence `seg`, as text: the finished chunks plus the
   * beginning of the one playing now — the subtitle grows along with the audio.
   */
  spokenText(seg: number): string {
    const pieces = this.pieces.get(seg)
    if (!pieces || pieces.length === 0) return ""
    const now = this.clock
    const parts: string[] = []
    for (const piece of pieces) {
      if (now >= piece.end) {
        parts.push(piece.text)
        continue
      }
      if (now > piece.start) {
        const total = piece.end - piece.start
        parts.push(spokenPrefix(piece.text, total > 0 ? (now - piece.start) / total : 1))
      }
      // The next chunk has not started yet: the subtitle stops here.
      break
    }
    return parts.filter(Boolean).join(" ")
  }

  /**
   * Removes from the queue the audio of the sentences AFTER `seg` (the one playing goes
   * on to the end). The following chunks then splice onto the end of what is left.
   */
  dropAfter(seg: number): void {
    const keep: AudioBufferSourceNode[] = []
    let end = 0
    for (const source of this.sources) {
      const info = this.meta.get(source)
      if (info?.seg !== undefined && info.seg > seg) {
        source.onended = null
        try {
          source.stop()
        } catch {
          // It had already finished on its own.
        }
        source.disconnect()
        this.meta.delete(source)
        continue
      }
      keep.push(source)
      end = Math.max(end, info?.end ?? 0)
    }
    const dropped = keep.length !== this.sources.length
    this.sources = keep
    this.nextAt = end
    for (const key of this.pieces.keys()) if (key > seg) this.pieces.delete(key)
    if (dropped) this.onEnded?.()
  }

  /** Stops what is scheduled — what has already played does not come back. */
  stopAll(): void {
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // It had already finished on its own.
      }
      source.disconnect()
    }
    this.sources = []
    this.meta.clear()
    this.pieces.clear()
    this.nextAt = 0
  }

  /** Closes the AudioContext: on unmount, so as not to leave a live audio output behind. */
  close(): void {
    this.stopAll()
    void this.context?.close().catch(() => {})
    this.context = null
  }
}

/**
 * The minimal bridge the state observer needs — the real `voiceApi`, in
 * practice, and a fake bridge in tests. Typed as `unknown` on
 * purpose: whoever reads the payload is the one who normalizes it, not this interface.
 */
export interface VoiceStatusSource {
  status: () => Promise<unknown>
  /** Subscribes to the state change channel and returns the unsubscribe. */
  onStatusChanged: (listener: () => void) => () => void
}

export interface VoiceStatusSubscription {
  /** Re-reads `voice:status` on demand (the window `focus` uses this). */
  read: () => void
  /** Cancels the channel subscription — leaves on unmount, with no orphan listener. */
  unsubscribe: () => void
}

/**
 * Watches the voice state in main: reads `voice:status` now and re-queries on every
 * `voice:status-changed`. Lives outside React so it can be tested with a
 * fake bridge (same reason as `ChunkPlayer`).
 *
 * The event is treated as a SIGNAL, not as the source of truth: the payload may
 * come whole (a new snapshot) or only with what changed, and the semantics of the fields
 * is still changing in main. That is why the event triggers a new query instead
 * of being interpreted here — whoever reads the payload (`readTtsStatus` and
 * `parseVoiceStatus`) already tolerates a map by id, a list and `installed`/`downloaded`.
 *
 * A main that did not answer (no channel, error, broken bridge) becomes `undefined`:
 * nobody is blocked by a status we could not read.
 */
export function subscribeVoiceStatus(
  source: VoiceStatusSource,
  apply: (raw: unknown) => void,
): VoiceStatusSubscription {
  const read = () => {
    let call: Promise<unknown>
    try {
      call = source.status()
    } catch {
      apply(undefined)
      return
    }
    void call.then(apply).catch(() => apply(undefined))
  }
  const unsubscribe = source.onStatusChanged(() => read())
  read()
  return { read, unsubscribe }
}

/** Voice state the UI consumes: the dictation snapshot and the TTS one. */
export interface VoiceStatusState {
  /** Payload normalized for `voiceTargetReady`; `null` = could not read it. */
  status: VoiceStatus | null
  /** What the speech button needs to know about TTS. */
  tts: TtsStatus
  /** Forces a new query (the events already re-query on their own). */
  refresh: () => void
}

/**
 * Reactive voice state, shared by the speech button and the dictation one:
 * queries `voice:status` on mount and re-queries on every `voice:status-changed`
 * (download, extraction, removal, failure). The window `focus` is only there as
 * a reinforcement — the download happens in Settings, a modal INSIDE this window,
 * so focus rarely fires (that was the bug: the button only unlocked on remount).
 *
 * `enabled: false` turns everything off — no query and no subscription.
 */
export function useVoiceStatus(enabled = true, engine: VoiceTtsEngine = "model"): VoiceStatusState {
  const [raw, setRaw] = useState<unknown>(undefined)
  const readRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!enabled) {
      readRef.current = null
      return
    }
    if (!window.ipcRenderer) return
    let alive = true
    const apply = (next: unknown) => {
      if (alive) setRaw(next)
    }
    const subscription = subscribeVoiceStatus(voiceApi, apply)
    readRef.current = subscription.read
    const onFocus = () => subscription.read()
    window.addEventListener("focus", onFocus)
    return () => {
      alive = false
      readRef.current = null
      window.removeEventListener("focus", onFocus)
      subscription.unsubscribe()
    }
  }, [enabled])

  const refresh = useCallback(() => readRef.current?.(), [])

  return useMemo(
    () => ({ status: parseVoiceStatus(raw), tts: readTtsStatus(raw, engine), refresh }),
    [raw, refresh, engine],
  )
}

/** Speech button state for the chosen audio priority. */
export function useTtsStatus(enabled: boolean, engine: VoiceTtsEngine = "model"): TtsStatus {
  return useVoiceStatus(enabled, engine).tts
}

/**
 * Speech hook: `speak(text)` synthesizes and plays, `stop()` interrupts. Only one
 * speech at a time — a new `speak` cuts the previous one, and nothing of it survives.
 */
export function useSpeak() {
  const [speaking, setSpeaking] = useState(false)
  /** Speech was requested and no chunk has arrived yet: the engine is generating the audio. */
  const [generating, setGenerating] = useState(false)
  /** Sentence of the continuous speech playing RIGHT NOW (`seg` of the chunks). */
  const [segment, setSegment] = useState<number | null>(null)
  /** Text of the sentence playing (what was attached with that `seg`). */
  const [segmentText, setSegmentText] = useState<string | null>(null)
  const segTextsRef = useRef(new Map<number, string>())
  /** Sound is going out at this instant (in continuous speech there may be gaps between sentences). */
  const [audible, setAudible] = useState(false)
  const lastSegRef = useRef<number | null>(null)
  const segTimersRef = useRef<{ seg: number; timer: ReturnType<typeof setTimeout> }[]>([])
  const clearSegments = useCallback(() => {
    for (const { timer } of segTimersRef.current) clearTimeout(timer)
    segTimersRef.current = []
    lastSegRef.current = null
    playingSegRef.current = null
    droppedRef.current = null
    segTextsRef.current.clear()
    setSegmentText(null)
    setSegment(null)
    setAudible(false)
  }, [])
  const generatingRef = useRef(false)
  const setGen = useCallback((value: boolean) => {
    if (generatingRef.current === value) return
    generatingRef.current = value
    setGenerating(value)
  }, [])
  const [error, setError] = useState<string | null>(null)

  const playerRef = useRef<ChunkPlayer | null>(null)
  const idRef = useRef<string | null>(null)
  /** `voice:tts:start` has not returned the id yet (chunks may have arrived first). */
  const awaitingRef = useRef(false)
  const earlyRef = useRef<ChunkPayload[]>([])
  /** A `done` that arrived before the id: without storing it, an immediate error from main
   *  got lost and the button stayed "speaking" (red, pulsing) forever. */
  const earlyDoneRef = useRef<DonePayload | null>(null)
  /** Continuous speech still open (more sentences coming): the `done` net waits. */
  const streamOpenRef = useRef(false)
  /** Sentences attached before main returned the id; and whether the end has already come too. */
  const pendingAppendRef = useRef<string[]>([])
  const pendingEndRef = useRef(false)
  /** Sentences already sent to main in this continuous speech (= the `seg` of the next one). */
  const sentCountRef = useRef(0)
  /** After a cut: chunks with `seg` in (keep, up to] arrive dead. */
  const droppedRef = useRef<{ keep: number; upTo: number } | null>(null)
  /** Sentence playing now, so the cut knows what to preserve. */
  const playingSegRef = useRef<number | null>(null)
  const doneRef = useRef(false)
  const cancelledRef = useRef(false)
  const guardRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const getPlayer = useCallback(() => {
    if (!playerRef.current) playerRef.current = new ChunkPlayer(createAudioContext)
    return playerRef.current
  }, [])

  const clearGuard = useCallback(() => {
    if (guardRef.current) {
      clearTimeout(guardRef.current)
      guardRef.current = null
    }
  }, [])

  /** Resets the state of the speech in progress (without touching `error`). */
  const reset = useCallback(() => {
    clearGuard()
    getPlayer().stopAll()
    idRef.current = null
    awaitingRef.current = false
    earlyRef.current = []
    earlyDoneRef.current = null
    streamOpenRef.current = false
    pendingAppendRef.current = []
    pendingEndRef.current = false
    doneRef.current = false
    cancelledRef.current = false
    setSpeaking(false)
    setGen(false)
    clearSegments()
  }, [clearGuard, clearSegments, getPlayer, setGen])

  /** Normal end: the audio ran out and main confirmed the speech. */
  const finish = useCallback(() => {
    reset()
  }, [reset])

  /** End with error: cuts what was scheduled and tells the UI. */
  const finishWithError = useCallback(
    (message: string) => {
      reset()
      setError(message)
    },
    [reset],
  )

  const maybeFinish = useCallback(() => {
    if (doneRef.current && getPlayer().pending === 0) finish()
  }, [finish, getPlayer])

  /**
   * Safety net for a `done` that never arrives: fires after the end of the audio
   * already scheduled with a wide slack, and is re-armed on every chunk (the deadline
   * follows the queue). The wide slack is on purpose: while the engine synthesizes
   * the next sentence, the silence is expected and cannot become a cut.
   */
  const armGuard = useCallback(() => {
    // Continuous speech open: the agent may take a while to send the next sentence, and
    // that is not a lost `done`. The net only arms after the end.
    if (streamOpenRef.current) {
      clearGuard()
      return
    }
    const player = getPlayer()
    const seconds = Math.max(player.scheduledEnd - player.clock, 0) + DONE_GRACE_SECONDS
    clearGuard()
    guardRef.current = setTimeout(finish, seconds * 1000)
  }, [clearGuard, finish, getPlayer])

  const playChunk = useCallback(
    (chunk: ChunkPayload) => {
      const samples = decodePcm16(chunk.pcm ?? "")
      // An empty chunk schedules nothing — but it cannot break the chaining.
      if (samples.length === 0) return
      const sampleRate = typeof chunk.sr === "number" && chunk.sr > 0 ? chunk.sr : TTS_SAMPLE_RATE
      const seg = chunk.seg
      // Sentence dropped by a cut while it was still being generated: arrives dead.
      const dropped = droppedRef.current
      if (typeof seg === "number" && dropped && seg > dropped.keep && seg <= dropped.upTo) return
      // Text of this chunk: the local engine sends its own; the model route sends
      // only the audio, so the slice comes from the whole sentence by the chunk position.
      const text =
        typeof chunk.text === "string" && chunk.text.trim()
          ? chunk.text.trim()
          : typeof seg === "number"
            ? speechPieceText(segTextsRef.current.get(seg) ?? "", chunk.i ?? 0, chunk.n ?? 1)
            : undefined
      const startsIn = getPlayer().schedule(samples, sampleRate, seg, text)
      setGen(false)
      setAudible(true)
      // New sentence in the continuous speech: it becomes "the one playing" at
      // the instant its audio starts, not when it arrives (it arrives earlier).
      if (typeof seg === "number" && seg !== lastSegRef.current && startsIn !== null) {
        lastSegRef.current = seg
        const timer = setTimeout(() => {
          playingSegRef.current = seg
          setSegment(seg)
          setSegmentText(segTextsRef.current.get(seg) ?? null)
        }, startsIn * 1000)
        segTimersRef.current.push({ seg, timer })
      }
      armGuard()
    },
    [armGuard, getPlayer, setGen],
  )

  useEffect(() => {
    const player = getPlayer()
    player.onEnded = () => {
      // Empty audio queue: silence (in continuous speech, waiting for the next sentence).
      if (player.pending === 0) setAudible(false)
      maybeFinish()
    }
    return () => {
      player.onEnded = null
    }
  }, [getPlayer, maybeFinish])

  useEffect(() => {
    const ipc = window.ipcRenderer
    if (!ipc) return

    const onChunk = (...args: unknown[]) => {
      const payload = args[0] as ChunkPayload | undefined
      if (!payload || typeof payload !== "object") return
      const id = idRef.current
      if (id === null) {
        // Arrived before main returned the id: store it to play in order.
        if (awaitingRef.current && !cancelledRef.current) earlyRef.current.push(payload)
        return
      }
      if (payload.id !== id) return
      playChunk(payload)
    }

    const onDone = (...args: unknown[]) => {
      const payload = args[0] as DonePayload | undefined
      if (!payload) return
      if (idRef.current === null) {
        if (awaitingRef.current && !cancelledRef.current) earlyDoneRef.current = payload
        return
      }
      if (payload.id !== idRef.current) return
      if (payload.error) {
        finishWithError(payload.error)
        return
      }
      doneRef.current = true
      maybeFinish()
    }

    const offChunk = ipc.on(CHANNEL.chunk, onChunk)
    const offDone = ipc.on(CHANNEL.done, onDone)
    return () => {
      ipc.off(CHANNEL.chunk, offChunk)
      ipc.off(CHANNEL.done, offDone)
    }
  }, [finishWithError, maybeFinish, playChunk])

  const stop = useCallback(() => {
    const id = idRef.current
    // Also takes down a start still in flight: the id that comes back will be cancelled.
    cancelledRef.current = true
    clearGuard()
    getPlayer().stopAll()
    idRef.current = null
    awaitingRef.current = false
    earlyRef.current = []
    earlyDoneRef.current = null
    streamOpenRef.current = false
    pendingAppendRef.current = []
    pendingEndRef.current = false
    doneRef.current = false
    setSpeaking(false)
    setGen(false)
    clearSegments()
    setError(null)
    if (id) cancelRequest(id)
  }, [clearGuard, clearSegments, getPlayer, setGen])

  /**
   * Opens a speech: cuts the previous one, prepares the audio in the gesture and asks main
   * for the id (`invoke`). Chunks that arrive before the id are stored and played
   * in order; the same goes for an early `done`.
   */
  const open = useCallback(
    (invoke: (ipc: NonNullable<typeof window.ipcRenderer>) => Promise<unknown>, onId?: (id: string) => void) => {
      const ipc = window.ipcRenderer
      if (!ipc) {
        setError(i18n.t("voice.tts.noChannel"))
        return false
      }
      // One speech at a time: a repeated click lands in the button's stop().
      stop()
      // stop() marked the speech as cancelled — this is a new one.
      cancelledRef.current = false
      setError(null)
      setSpeaking(true)
      setGen(true)
      awaitingRef.current = true
      // The context is created in the click gesture — it is what unlocks audio in Chromium.
      try {
        void getPlayer().ensure().resume()
      } catch (reason) {
        finishWithError(reason instanceof Error ? reason.message : String(reason))
        return false
      }

      void invoke(ipc)
        .then((raw) => {
          const id = (raw as { id?: string } | null)?.id
          if (!id) {
            finishWithError("voice:tts:start sem id")
            return
          }
          if (cancelledRef.current) {
            cancelRequest(id)
            return
          }
          awaitingRef.current = false
          idRef.current = id
          onId?.(id)
          const early = earlyRef.current
          earlyRef.current = []
          for (const chunk of early) {
            if (chunk.id === id || chunk.id === undefined) playChunk(chunk)
          }
          const earlyDone = earlyDoneRef.current
          earlyDoneRef.current = null
          if (earlyDone && (earlyDone.id === id || earlyDone.id === undefined)) {
            if (earlyDone.error) {
              finishWithError(earlyDone.error)
              return
            }
            doneRef.current = true
            maybeFinish()
          }
        })
        .catch((reason: unknown) => {
          finishWithError(reason instanceof Error ? reason.message : String(reason))
        })
      return true
    },
    [finishWithError, getPlayer, maybeFinish, playChunk, setGen, stop],
  )

  const speak = useCallback(
    (text: string, request: SpeakRequest = {}) => {
      const trimmed = text.trim()
      if (!trimmed) return
      open((ipc) =>
        ipc.invoke(CHANNEL.start, {
          text: trimmed,
          voice: request.voice,
          lang: request.lang,
          speed: request.speed,
          engine: request.engine,
        }),
      )
    },
    [open],
  )

  /**
   * CONTINUOUS speech: opens a speech without text, which receives sentences with
   * `appendSpeech` and ends with `endSpeech`. Main generates the next sentence
   * while the previous one plays — that is what removes the silence between the sentences of an
   * answer that arrives in pieces (call mode).
   */
  const speakStream = useCallback(
    (request: SpeakRequest = {}) => {
      pendingAppendRef.current = []
      pendingEndRef.current = false
      sentCountRef.current = 0
      const opened = open(
        (ipc) =>
          ipc.invoke(CHANNEL.streamStart, {
            voice: request.voice,
            lang: request.lang,
            speed: request.speed,
            engine: request.engine,
          }),
        (id) => {
          const ipc = window.ipcRenderer
          for (const text of pendingAppendRef.current) {
            segTextsRef.current.set(sentCountRef.current++, text)
            void ipc?.invoke(CHANNEL.streamAppend, { id, text })
          }
          pendingAppendRef.current = []
          if (pendingEndRef.current) void ipc?.invoke(CHANNEL.streamEnd, { id })
        },
      )
      // After the open: the stop() in there resets this mark.
      if (opened) streamOpenRef.current = true
    },
    [open],
  )

  /** Next sentence of the continuous speech (in the order it should be said). */
  const appendSpeech = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed || !streamOpenRef.current) return
    const id = idRef.current
    if (id) {
      // Same numbering as main: the sentence N sent is the `seg` N of the chunks.
      segTextsRef.current.set(sentCountRef.current++, trimmed)
      void window.ipcRenderer?.invoke(CHANNEL.streamAppend, { id, text: trimmed })
    } else if (awaitingRef.current) pendingAppendRef.current.push(trimmed)
  }, [])

  /**
   * Cuts the continuous speech after the sentence playing (or the first one, if
   * nothing has played yet): what was already generated and scheduled leaves the player, what
   * still awaits synthesis leaves the main queue, and the speech stays open for
   * new sentences. It is the "agent moved on to the tools" of call mode.
   */
  const trimSpeech = useCallback(() => {
    if (!streamOpenRef.current) return
    const keep = Math.max(playingSegRef.current ?? 0, 0)
    const id = idRef.current
    if (!id) {
      // Nothing has gone out yet: only the first requested sentence stays.
      pendingAppendRef.current = pendingAppendRef.current.slice(0, 1)
      return
    }
    droppedRef.current = { keep, upTo: sentCountRef.current - 1 }
    void window.ipcRenderer?.invoke(CHANNEL.streamClear, { id })
    for (const entry of segTimersRef.current) if (entry.seg > keep) clearTimeout(entry.timer)
    segTimersRef.current = segTimersRef.current.filter((entry) => entry.seg <= keep)
    if (lastSegRef.current !== null && lastSegRef.current > keep) lastSegRef.current = keep
    for (const key of segTextsRef.current.keys()) if (key > keep) segTextsRef.current.delete(key)
    getPlayer().dropAfter(keep)
  }, [getPlayer])

  /** No more sentences: the speech ends when what has already been requested finishes playing. */
  const endSpeech = useCallback(() => {
    if (!streamOpenRef.current) return
    streamOpenRef.current = false
    const id = idRef.current
    if (id) void window.ipcRenderer?.invoke(CHANNEL.streamEnd, { id })
    else if (awaitingRef.current) pendingEndRef.current = true
    // Now the net for a `done` that does not arrive does apply.
    if (getPlayer().pending > 0) armGuard()
  }, [armGuard, getPlayer])

  // The persona reacts to the audio that is going OUT, and it lives in another branch of
  // the tree: the signal goes through a global store (see stores/voice-activity).
  useEffect(() => {
    useVoiceActivity.getState().setSpeaking(speaking)
  }, [speaking])
  useEffect(() => () => useVoiceActivity.getState().setSpeaking(false), [])

  // Unmounted: no listeners (effects above), no pending speech and no AudioContext.
  useEffect(() => {
    return () => {
      const id = idRef.current
      idRef.current = null
      awaitingRef.current = false
      clearGuard()
      for (const { timer } of segTimersRef.current) clearTimeout(timer)
      playerRef.current?.close()
      playerRef.current = null
      if (id) cancelRequest(id)
    }
  }, [clearGuard])

  /** Hides the error notice without touching any speech (the button goes back to normal). */
  const dismissError = useCallback(() => setError(null), [])

  /**
   * Text of sentence `seg` that has already played — the finished chunks plus the beginning of
   * the one playing. Reads the audio clock on the spot: whoever shows the subtitle
   * needs to re-render while the speech runs (call mode does that).
   */
  const segSpokenText = useCallback((seg: number) => playerRef.current?.spokenText(seg) ?? "", [])

  /** Texts of the sentences BEFORE `seg`, in the order they were spoken. */
  const beforeSegText = useCallback((seg: number) => {
    const out: { seg: number; text: string }[] = []
    for (const [key, text] of segTextsRef.current) if (key < seg) out.push({ seg: key, text })
    return out.sort((a, b) => a.seg - b.seg).map((entry) => entry.text)
  }, [])

  /**
   * All the text already requested for the speech, in sentence order — including what
   * has not played yet. It is the script the subtitle takes the next line from.
   */
  const speechScript = useCallback(() => {
    const entries = [...segTextsRef.current.entries()].sort((a, b) => a[0] - b[0])
    return entries.map(([, text]) => text).join(" ")
  }, [])

  return { speak, speakStream, appendSpeech, endSpeech, trimSpeech, stop, speaking, generating, segment, segmentText, segSpokenText, beforeSegText, speechScript, audible, error, dismissError }
}
