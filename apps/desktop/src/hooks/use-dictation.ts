import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  DICTATION_CHUNK_FRAMES,
  DICTATION_SAMPLE_RATE,
  PCM_WORKLET_PROCESSOR,
  dictationSupported,
  pcm16ToBase64,
  pcmLevel,
  pcmWorkletUrl,
  resolveVoiceSttSettings,
  type VoiceSttSettings,
} from "@/src/lib/dictation"
import { useAppSettings } from "@/src/stores/app-settings"
import { useVoiceActivity } from "@/src/stores/voice-activity"

/**
 * Voice dictation in the input: opens the microphone, sends the audio as PCM16 to the
 * engine in main and returns the text (provisional and final).
 *
 * The IPC contract is fixed and lives in the main process:
 *   invoke "voice:stt:start" { engine, modelId?, language?, sampleRate, threads?, live } -> { id }
 *   invoke "voice:stt:push"  { id, pcm: base64 PCM16 }
 *   invoke "voice:stt:stop"  { id } -> { text, audioMs, ms }
 *   invoke "voice:stt:cancel" { id }
 *   event "voice:stt:partial" -> { id, text }
 *
 * Two rules the voice lab paid to learn (vozlab §13/§14):
 * the microphone is always released and the AudioContext always closed, whatever
 * happens in the middle of the capture; and the AudioContext is created inside the user
 * gesture, otherwise on some engines it starts suspended and the graph never runs.
 */

const CHANNELS = {
  start: "voice:stt:start",
  push: "voice:stt:push",
  stop: "voice:stt:stop",
  cancel: "voice:stt:cancel",
  partial: "voice:stt:partial",
} as const

/** Waits for the worklet `flush` when the button is released: without it the rest of the
 *  1024-frame block (~64 ms) would stay in the processor and the last syllable would be lost. */
const FLUSH_WAIT_MS = 40

interface Capture {
  sessionId: string
  ctx: AudioContext
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  sink: GainNode
  /** Worklet blocks not sent yet (grouped into ~128 ms chunks). */
  pending: Int16Array[]
  frames: number
}

export interface DictationCallbacks {
  /** Provisional text from the engine (the `live` preference decides whether it goes to the input). */
  onPartial?: (text: string) => void
  /** End of the capture. Comes back empty when nobody spoke — whoever showed provisional
   *  text uses it to put the input back the way it was. */
  onFinal?: (text: string) => void
  /** Level (0..1) of each microphone block (~64 ms) — feeds the waveform. */
  onLevel?: (level: number) => void
}

export interface Dictation {
  settings: VoiceSttSettings
  /** Microphone open, capturing. */
  listening: boolean
  /** Permission/engine on the way — the button can already look active. */
  starting: boolean
  error: string | null
  dismissError: () => void
  start: () => Promise<void>
  stop: () => Promise<void>
  cancel: () => void
}

/** Sends what has accumulated as one PCM16 chunk (base64). */
function pushPending(capture: Capture): Promise<unknown> {
  if (capture.frames === 0) return Promise.resolve()
  const pcm = new Int16Array(capture.frames)
  let offset = 0
  for (const chunk of capture.pending) {
    pcm.set(chunk, offset)
    offset += chunk.length
  }
  capture.pending = []
  capture.frames = 0
  return window.ipcRenderer.invoke(CHANNELS.push, { id: capture.sessionId, pcm: pcm16ToBase64(pcm) })
}

/**
 * Releases the track and closes the AudioContext — ALWAYS, including when the engine
 * changes, the permission is denied or the component unmounts. A dangling microphone is
 * the lab's documented defect (the next capture came out mute).
 */
function releaseCapture(capture: Capture) {
  capture.pending = []
  capture.frames = 0
  capture.node.port.onmessage = null
  capture.source.disconnect()
  capture.node.disconnect()
  capture.sink.disconnect()
  for (const track of capture.stream.getTracks()) track.stop()
  // close() rejects if the context was already closed — not an error for us.
  void capture.ctx.close().catch(() => {})
}

/** "Cancelled while opening" marker — not an error to show. */
const CANCELLED = Symbol("dictation-cancelled")

export function useDictation(
  callbacks: DictationCallbacks = {},
  /** Forces preferences for this capture (the call always wants live text). */
  overrides: { live?: boolean } = {},
): Dictation {
  const settings = useAppSettings((s) => s.settings)
  const forceLive = overrides.live
  const voice = useMemo(() => {
    const resolved = resolveVoiceSttSettings(settings)
    return forceLive === undefined ? resolved : { ...resolved, live: forceLive }
  }, [settings, forceLive])
  const [listening, setListening] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const captureRef = useRef<Capture | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const startingRef = useRef(false)
  // The button can be released before the microphone opens: end as soon as it opens.
  const stopRequestedRef = useRef(false)
  /**
   * Cancellation requested while the capture is STILL OPENING (engine starting, microphone
   * request in progress). Without this cancel() had nothing to cancel, the
   * opening finished on its own and left the microphone open with no owner — the
   * next start() saw the orphan capture, did not open another one and inherited its text.
   */
  const cancelRequestedRef = useRef(false)
  const callbacksRef = useRef(callbacks)
  useEffect(() => {
    callbacksRef.current = callbacks
  })

  // Engine partials: only the capture in progress cares (the id must match).
  useEffect(() => {
    const ipc = window.ipcRenderer
    if (!ipc) return
    const wrapper = ipc.on(CHANNELS.partial, (payload) => {
      const data = payload as { id?: string; text?: string } | undefined
      if (!data || data.id !== sessionIdRef.current) return
      if (typeof data.text === "string" && data.text) callbacksRef.current.onPartial?.(data.text)
    })
    return () => ipc.off(CHANNELS.partial, wrapper)
  }, [])

  /** Ends the capture: releases the microphone, closes the audio and waits for the final
   *  text (or cancels the session, without text). */
  const finish = useCallback(async (capture: Capture, cancel = false) => {
    captureRef.current = null
    sessionIdRef.current = null
    setListening(false)
    try {
      capture.node.port.postMessage("flush")
      await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS))
      await pushPending(capture)
    } catch {
      // Main may have died midway: whatever text comes is still usable.
    }
    // Microphone closed BEFORE waiting for the transcription: the engine does not need
    // it and the open track gets in the way of the next use (and startles the user).
    releaseCapture(capture)
    try {
      if (cancel) {
        await window.ipcRenderer.invoke(CHANNELS.cancel, { id: capture.sessionId })
        return
      }
      const result = (await window.ipcRenderer.invoke(CHANNELS.stop, { id: capture.sessionId })) as
        | { text?: unknown }
        | undefined
      callbacksRef.current.onFinal?.(typeof result?.text === "string" ? result.text : "")
    } catch (err) {
      // With no final text, the provisional text already in the input stays: better the
      // user fixing what they saw than the text vanishing from the screen.
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const start = useCallback(async () => {
    if (captureRef.current || startingRef.current) return
    if (!voice.enabled || !dictationSupported()) return
    const ipc = window.ipcRenderer
    stopRequestedRef.current = false
    cancelRequestedRef.current = false
    startingRef.current = true
    setStarting(true)
    setError(null)
    // Every async step of the opening checks whether it should still open.
    const bail = () => {
      if (cancelRequestedRef.current) throw CANCELLED
    }

    let ctx: AudioContext | null = null
    let stream: MediaStream | null = null
    let sessionId: string | null = null
    try {
      // 1) The AudioContext is created INSIDE the gesture (the button's pointerdown) and is
      //    resumed right away: outside the gesture it may start suspended and then the
      //    worklet never runs — the "recording" would be mute (vozlab §14).
      ctx = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE })
      if (ctx.state === "suspended") await ctx.resume()
      bail()
      if (ctx.state !== "running") throw new Error("audio-context-not-running")

      // 2) Session in the engine before opening the microphone: a model that was not downloaded fails
      //    here, with nobody holding the track.
      const started = (await ipc.invoke(CHANNELS.start, {
        engine: voice.engine,
        modelId: voice.modelId ?? undefined,
        language: voice.language,
        sampleRate: ctx.sampleRate,
        threads: voice.threads,
        live: voice.live,
      })) as { id?: unknown } | undefined
      if (!started || typeof started.id !== "string") throw new Error("voice:stt:start without id")
      sessionId = started.id
      bail()

      // 3) Microphone and worklet
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // `ideal`, not `exact`: the chosen microphone unplugged falls back to the system
          // default instead of taking the dictation down with OverconstrainedError.
          ...(voice.micDeviceId ? { deviceId: { ideal: voice.micDeviceId } } : {}),
        },
      })
      bail()
      await ctx.audioWorklet.addModule(pcmWorkletUrl(document.baseURI))
      bail()
      const node = new AudioWorkletNode(ctx, PCM_WORKLET_PROCESSOR)
      const source = ctx.createMediaStreamSource(stream)
      const sink = ctx.createGain()
      // Gain 0 at the destination keeps the graph being pulled (without it the worklet
      // is not called) without sending the microphone back to the speakers.
      sink.gain.value = 0
      source.connect(node)
      node.connect(sink)
      sink.connect(ctx.destination)

      const capture: Capture = { sessionId, ctx, stream, source, node, sink, pending: [], frames: 0 }
      node.port.onmessage = (event) => {
        const pcm = (event.data as { pcm?: Int16Array } | undefined)?.pcm
        if (!pcm || pcm.length === 0) return
        callbacksRef.current.onLevel?.(pcmLevel(pcm))
        capture.pending.push(pcm)
        capture.frames += pcm.length
        if (capture.frames >= DICTATION_CHUNK_FRAMES) void pushPending(capture).catch(() => {})
      }
      captureRef.current = capture
      sessionIdRef.current = sessionId
      // The capture started: release the start lock BEFORE waiting for the
      // transcription, otherwise a new dictation would be blocked for ~1 s.
      startingRef.current = false
      setStarting(false)
      setListening(true)

      if (stopRequestedRef.current) {
        stopRequestedRef.current = false
        await finish(capture)
      }
    } catch (err) {
      // Failed midway: no session dangling in main, no microphone left open.
      if (sessionId) {
        void Promise.resolve(ipc.invoke(CHANNELS.cancel, { id: sessionId })).catch(() => {})
      }
      sessionIdRef.current = null
      if (stream) for (const track of stream.getTracks()) track.stop()
      if (ctx) void ctx.close().catch(() => {})
      // Cancelled in the middle of the opening is not an error: it just does not open.
      if (err !== CANCELLED) setError(err instanceof Error ? err.message : String(err))
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }, [finish, voice])

  const stop = useCallback(async () => {
    const capture = captureRef.current
    if (!capture) {
      // Released before the capture existed: whoever finishes the start ends it.
      stopRequestedRef.current = true
      return
    }
    await finish(capture)
  }, [finish])

  const cancel = useCallback(() => {
    stopRequestedRef.current = false
    const capture = captureRef.current
    if (!capture) {
      // Still opening: whoever is opening gives up at the next step.
      if (startingRef.current) cancelRequestedRef.current = true
      return
    }
    void finish(capture, true)
  }, [finish])

  // Unmounted in the middle of the speech (chat switch, panel closed): release the
  // microphone and cancel the session, without waiting for text.
  useEffect(
    () => () => {
      // Unmounted with the capture still opening: it cannot finish opening.
      cancelRequestedRef.current = true
      const capture = captureRef.current
      captureRef.current = null
      sessionIdRef.current = null
      if (!capture) return
      releaseCapture(capture)
      void Promise.resolve(window.ipcRenderer.invoke(CHANNELS.cancel, { id: capture.sessionId })).catch(() => {})
    },
    [],
  )

  // The persona stays in "listening" while recording — from the instant of the press
  // (`starting`), which is when the user already understands they are speaking. The state is
  // global because the persona lives in another branch of the tree (stores/voice-activity).
  useEffect(() => {
    useVoiceActivity.getState().setListening(listening || starting)
  }, [listening, starting])
  useEffect(() => () => useVoiceActivity.getState().setListening(false), [])

  /** Hides the error notice (the button goes back to normal without a new attempt). */
  const dismissError = useCallback(() => setError(null), [])

  return { settings: voice, listening, starting, error, start, stop, cancel, dismissError }
}
