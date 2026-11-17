/**
 * Dictation in the companion app. Two ways to turn speech into text, chosen in the settings:
 *
 * - **native** (default): the phone's own recognizer through `expo-speech-recognition`
 *   (iOS Speech / Android SpeechRecognizer). Words arrive while you speak. It needs the native
 *   module, which a dev client built earlier does not have — then it quietly uses the desktop.
 * - **desktop**: the phone records and the desktop's voice model transcribes. The audio is sent
 *   again every second or so (the last seconds of it), so the text builds up while you speak;
 *   the whole recording is transcribed once more when you stop, and that is what stays.
 *
 * Both report the same things to the composer: `onPartial(text)` as the text grows (empty when it
 * is withdrawn — cancel, failure) and `onText(text)` once, with the final text.
 *
 * The microphone of the desktop mode comes from the `AudioStream` of expo-audio, which delivers
 * raw PCM — so there is no file and no codec in the path: we ask for int16, mono, 16 kHz and
 * send the buffers as base64 to `POST /api/voice/transcribe`. If the hardware does not deliver
 * exactly 16 kHz, we use the rate that came in each buffer and report it to the desktop.
 */
import { useCallback, useEffect, useReducer, useRef, useState, type MutableRefObject } from 'react'
import { useAudioStream, requestRecordingPermissionsAsync, type AudioStreamBuffer } from 'expo-audio'
import { useConnectionStore } from '~/stores/connection-store'
import { useDictationPrefsStore } from '~/stores/dictation-prefs-store'
import { bytesToBase64, concatPcm, pcmDurationMs } from '~/lib/voice-pcm'
import { reasonFromHttpError } from '~/lib/http-error'
import {
  EMPTY_NATIVE_TRANSCRIPT,
  PARTIAL_EVERY_MS,
  PARTIAL_MIN_AUDIO_MS,
  PARTIAL_WINDOW_SECONDS,
  applyNativeResult,
  dictationReducer,
  nativeText,
  pcmDbLevel,
  pcmLevel,
  pcmTail,
  pushLevel,
  speechLocale,
  volumeToLevel,
  voiceLanguage,
  type NativeTranscript,
} from '~/lib/dictation-logic'
import { getNativeSpeech } from '~/lib/native-speech'
import i18n from '~/i18n'

const TARGET_SAMPLE_RATE = 16000

/** Below this it is an accidental touch on the microphone, not speech — not worth transcribing. */
const MIN_AUDIO_MS = 200

/** Microphone levels (0..1, oldest → newest) and when the last one arrived. A ref, not state:
 *  buffers come ~10x/s and only the waveform reads them. */
export interface DictationLevels {
  values: number[]
  at: number
  /** Latest buffer on the dB scale the call's speech detection uses (desktop mode only). */
  db?: number
}

const MAX_LEVELS = 96

export interface Dictation {
  /** Recording now (the button becomes "stop"). */
  recording: boolean
  /** Waiting for the final text (desktop transcribing, or the recognizer closing). */
  transcribing: boolean
  /** Failure visible to the user (permission, offline, voice engine unavailable). */
  error: string | null
  /** Starts recording; if already recording, stops and transcribes. */
  toggle: () => void
  /** Discards the recording (or ignores the transcript still on its way) without inserting. */
  cancel: () => void
  /** Live microphone levels for the waveform. */
  levels: MutableRefObject<DictationLevels>
  /** Clears the error message. */
  clearError: () => void
}

/** The text as it is being recognized (empty = withdraw what was shown). */
export type PartialHandler = (text: string) => void

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

// ─── Desktop transcription, with partial text ────────────────────────────────

export function useDesktopDictation(onText: (text: string) => void, language?: string, onPartial?: PartialHandler): Dictation {
  const [phase, dispatch] = useReducer(dictationReducer, 'idle')
  const recording = phase === 'recording'
  const transcribing = phase === 'transcribing'
  // Bumped on every start/cancel: a transcript that comes back for an older run is dropped.
  const runRef = useRef(0)
  const levels = useRef<DictationLevels>({ values: [], at: 0 })
  // Defaults to the app language, so dictating in a pt-BR app is not left to auto-detection.
  const lang = language ?? voiceLanguage(i18n.language)
  const [error, setError] = useState<string | null>(null)

  const http = useConnectionStore((s) => s.http)
  const chunksRef = useRef<Uint8Array[]>([])
  const sampleRateRef = useRef(TARGET_SAMPLE_RATE)
  // A buffer that arrives after the stop (the capture stops in the middle of a chunk)
  // would be written into the NEXT dictation: the flag closes the door at stop time.
  const capturingRef = useRef(false)
  const partialRef = useRef(onPartial)
  useEffect(() => {
    partialRef.current = onPartial
  }, [onPartial])

  const handleBuffer = useCallback((buffer: AudioStreamBuffer) => {
    if (!capturingRef.current) return
    if (buffer.sampleRate > 0) sampleRateRef.current = buffer.sampleRate
    const bytes = new Uint8Array(buffer.data)
    chunksRef.current.push(bytes)
    pushLevel(levels.current.values, pcmLevel(bytes), MAX_LEVELS)
    levels.current.db = pcmDbLevel(bytes)
    levels.current.at = Date.now()
  }, [])

  const { stream } = useAudioStream({
    sampleRate: TARGET_SAMPLE_RATE,
    channels: 1,
    encoding: 'int16',
    onBuffer: handleBuffer,
  })

  // Switching screens in the middle of the recording cannot leave the microphone open.
  useEffect(() => {
    return () => {
      try {
        stream?.stop()
      } catch {
        /* already stopped */
      }
    }
  }, [stream])

  // Partial text while recording: every `PARTIAL_EVERY_MS` the last seconds of audio go to the
  // desktop — one request at a time, and an answer for an older run (or after the stop) is dropped.
  const wantsPartial = !!onPartial
  useEffect(() => {
    if (!recording || !http || !wantsPartial) return
    const run = runRef.current
    let inFlight = false
    let lastBytes = 0
    const timer = setInterval(() => {
      if (inFlight || !capturingRef.current || run !== runRef.current) return
      const total = chunksRef.current.reduce((n, c) => n + c.length, 0)
      if (total === lastBytes || pcmDurationMs(total, sampleRateRef.current) < PARTIAL_MIN_AUDIO_MS) return
      lastBytes = total
      const pcm = pcmTail(concatPcm(chunksRef.current), sampleRateRef.current, PARTIAL_WINDOW_SECONDS)
      inFlight = true
      http
        .transcribePcm(bytesToBase64(pcm), sampleRateRef.current, { language: lang })
        .then((res) => {
          if (!capturingRef.current || run !== runRef.current || !res.ok) return
          const text = res.data?.text?.trim()
          if (text) partialRef.current?.(text)
        })
        .catch(() => {
          /* a failed partial is not an error: the final transcription still runs */
        })
        .finally(() => {
          inFlight = false
        })
    }, PARTIAL_EVERY_MS)
    return () => clearInterval(timer)
  }, [recording, http, lang, wantsPartial])

  const start = useCallback(async () => {
    setError(null)
    const run = ++runRef.current
    dispatch({ type: 'press' })
    if (!stream) {
      dispatch({ type: 'startFailed' })
      setError(i18n.t('promptInput.voice.unsupported'))
      return
    }
    try {
      const permission = await requestRecordingPermissionsAsync()
      if (run !== runRef.current) return
      if (!permission.granted) {
        dispatch({ type: 'startFailed' })
        setError(i18n.t('promptInput.voice.permission'))
        return
      }
      chunksRef.current = []
      sampleRateRef.current = TARGET_SAMPLE_RATE
      levels.current = { values: [], at: 0 }
      capturingRef.current = true
      await stream.start()
      if (run !== runRef.current) {
        // Cancelled while the microphone was opening.
        try { stream.stop() } catch { /* already stopped */ }
        return
      }
      dispatch({ type: 'started' })
    } catch (err) {
      capturingRef.current = false
      dispatch({ type: 'startFailed' })
      setError(i18n.t('promptInput.voice.failed') + ': ' + messageOf(err))
    }
  }, [stream])

  const stop = useCallback(async () => {
    capturingRef.current = false
    const run = runRef.current
    try {
      stream?.stop()
    } catch {
      /* already stopped */
    }
    dispatch({ type: 'stop' })

    const pcm = concatPcm(chunksRef.current)
    chunksRef.current = []
    const durationMs = pcmDurationMs(pcm.length, sampleRateRef.current)
    if (pcm.length === 0 || durationMs < MIN_AUDIO_MS) {
      partialRef.current?.('')
      dispatch({ type: 'finished' })
      setError(i18n.t('promptInput.voice.empty'))
      return
    }

    if (!http) {
      partialRef.current?.('')
      dispatch({ type: 'finished' })
      setError(i18n.t('promptInput.voice.offline'))
      return
    }

    try {
      const res = await http.transcribePcm(bytesToBase64(pcm), sampleRateRef.current, { language: lang })
      if (run !== runRef.current) return
      if (!res.ok) {
        // 503 from the desktop (engine unavailable / model not downloaded) carries the reason.
        partialRef.current?.('')
        setError(reasonFromHttpError(res.error) ?? i18n.t('promptInput.voice.failed'))
        return
      }
      const text = res.data?.text?.trim()
      if (text) onText(text)
      else {
        partialRef.current?.('')
        setError(i18n.t('promptInput.voice.noSpeech'))
      }
    } catch (err) {
      if (run === runRef.current) {
        partialRef.current?.('')
        setError(i18n.t('promptInput.voice.failed') + ': ' + messageOf(err))
      }
    } finally {
      if (run === runRef.current) dispatch({ type: 'finished' })
    }
  }, [stream, http, lang, onText])

  const cancel = useCallback(() => {
    runRef.current++
    capturingRef.current = false
    chunksRef.current = []
    try {
      stream?.stop()
    } catch {
      /* already stopped */
    }
    partialRef.current?.('')
    dispatch({ type: 'cancel' })
  }, [stream])

  const toggle = useCallback(() => {
    if (transcribing) return
    if (recording) void stop()
    else void start()
  }, [recording, transcribing, start, stop])

  const clearError = useCallback(() => setError(null), [])

  return { recording, transcribing, error, toggle, cancel, levels, clearError }
}

// ─── The phone's own recognizer ──────────────────────────────────────────────

const NATIVE_LEVEL_INTERVAL_MS = 80


function nativeErrorMessage(code: string, message: string): string | null {
  // The person (or a cancel) ended it: not a failure.
  if (code === 'aborted') return null
  if (code === 'no-speech' || code === 'speech-timeout') return i18n.t('promptInput.voice.noSpeech')
  if (code === 'not-allowed') return i18n.t('promptInput.voice.permission')
  if (code === 'language-not-supported' || code === 'service-not-allowed') return i18n.t('promptInput.voice.unsupported')
  return i18n.t('promptInput.voice.failed') + (message ? ': ' + message : '')
}

/** The recognizer itself cannot run here (a simulator, a language with no model): the desktop takes over. */
function recognizerUnavailable(code: string, message: string): boolean {
  return code === 'service-not-allowed' || code === 'language-not-supported' || /initialize recognizer|not available/i.test(message)
}

function useNativeDictation(
  onText: (text: string) => void,
  language?: string,
  onPartial?: PartialHandler,
  onUnavailable?: () => void,
): Dictation {
  const native = getNativeSpeech()
  const [phase, dispatch] = useReducer(dictationReducer, 'idle')
  const recording = phase === 'recording'
  const transcribing = phase === 'transcribing'
  const runRef = useRef(0)
  const levels = useRef<DictationLevels>({ values: [], at: 0 })
  const [error, setError] = useState<string | null>(null)
  const transcriptRef = useRef<NativeTranscript>(EMPTY_NATIVE_TRANSCRIPT)
  // The error of this session, kept until `end`, which closes it (the order of the two events is not guaranteed).
  const errorRef = useRef<string | null>(null)
  const onTextRef = useRef(onText)
  const partialRef = useRef(onPartial)
  const unavailableRef = useRef(onUnavailable)
  const unavailableHit = useRef(false)
  useEffect(() => {
    onTextRef.current = onText
    partialRef.current = onPartial
    unavailableRef.current = onUnavailable
  }, [onText, onPartial, onUnavailable])
  // The locale is read when starting; the app language can change between sessions.
  const localeRef = useRef(speechLocale(language ?? i18n.language))
  useEffect(() => {
    localeRef.current = speechLocale(language ?? i18n.language)
  }, [language])

  // The module's events. Subscribed in an effect (and not with its `useSpeechRecognitionEvent` hook) so the
  // handlers can read the refs: they only run when an event fires, never during render.
  useEffect(() => {
    if (!native) return
    const subscriptions = [
      native.module.addListener('start', () => {
        dispatch({ type: 'started' })
      }),
      native.module.addListener('result', (event) => {
        const transcript = event.results?.[0]?.transcript ?? ''
        transcriptRef.current = applyNativeResult(transcriptRef.current, transcript, event.isFinal)
        partialRef.current?.(nativeText(transcriptRef.current))
      }),
      native.module.addListener('volumechange', (event) => {
        pushLevel(levels.current.values, volumeToLevel(event.value), MAX_LEVELS)
        levels.current.at = Date.now()
      }),
      native.module.addListener('error', (event) => {
        if (recognizerUnavailable(event.error, event.message ?? '')) unavailableHit.current = true
        const message = nativeErrorMessage(event.error, event.message)
        if (message) errorRef.current = message
      }),
      native.module.addListener('end', () => {
        // The session is over (stopped, cancelled, silence or failure): this is where the text lands.
        const text = nativeText(transcriptRef.current).trim()
        const failure = errorRef.current
        transcriptRef.current = EMPTY_NATIVE_TRANSCRIPT
        errorRef.current = null
        const unavailable = unavailableHit.current
        unavailableHit.current = false
        // A cancel already withdrew the text and reset the phase: this `end` belongs to it.
        if (runRef.current === 0) return
        if (unavailable && !text) {
          partialRef.current?.('')
          dispatch({ type: 'cancel' })
          unavailableRef.current?.()
          return
        }
        if (text) {
          onTextRef.current(text)
        } else {
          partialRef.current?.('')
          if (failure) setError(failure)
        }
        dispatch({ type: 'cancel' })
      }),
    ]
    return () => {
      for (const subscription of subscriptions) subscription.remove()
    }
  }, [native])

  // Leaving the screen with the recognizer open would leave the microphone on.
  useEffect(() => {
    return () => {
      try {
        native?.module.abort()
      } catch {
        /* nothing running */
      }
    }
  }, [native])

  const start = useCallback(async () => {
    setError(null)
    errorRef.current = null
    unavailableHit.current = false
    transcriptRef.current = EMPTY_NATIVE_TRANSCRIPT
    levels.current = { values: [], at: 0 }
    const run = ++runRef.current
    dispatch({ type: 'press' })
    if (!native) {
      dispatch({ type: 'startFailed' })
      setError(i18n.t('promptInput.voice.unsupported'))
      return
    }
    try {
      const permission = await native.module.requestPermissionsAsync()
      if (run !== runRef.current) return
      if (!permission.granted) {
        dispatch({ type: 'startFailed' })
        setError(i18n.t('promptInput.voice.permission'))
        return
      }
      native.module.start({
        lang: localeRef.current,
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        volumeChangeEventOptions: { enabled: true, intervalMillis: NATIVE_LEVEL_INTERVAL_MS },
      })
    } catch (err) {
      dispatch({ type: 'startFailed' })
      setError(i18n.t('promptInput.voice.failed') + ': ' + messageOf(err))
    }
  }, [native])

  const stop = useCallback(() => {
    dispatch({ type: 'stop' })
    try {
      // Lets the recognizer finish the last words; the `end` event delivers the text.
      native?.module.stop()
    } catch {
      dispatch({ type: 'cancel' })
    }
  }, [native])

  const cancel = useCallback(() => {
    // `end` still fires after an abort: bumping the run first makes it a no-op for this session.
    runRef.current = 0
    transcriptRef.current = EMPTY_NATIVE_TRANSCRIPT
    errorRef.current = null
    try {
      native?.module.abort()
    } catch {
      /* nothing running */
    }
    partialRef.current?.('')
    dispatch({ type: 'cancel' })
  }, [native])

  const toggle = useCallback(() => {
    if (transcribing || phase === 'starting') return
    if (recording) stop()
    else void start()
  }, [transcribing, phase, recording, stop, start])

  const clearError = useCallback(() => setError(null), [])

  return { recording, transcribing, error, toggle, cancel, levels, clearError }
}

// ─── The one the composer uses ───────────────────────────────────────────────

/**
 * Both implementations stay mounted (hooks cannot be conditional) and idle; the setting picks which
 * one the composer talks to. A build without the native module always gets the desktop one.
 */
export function useDictation(
  onText: (text: string) => void,
  language?: string,
  onPartial?: PartialHandler,
): Dictation {
  const mode = useDictationPrefsStore((s) => s.mode)
  // Once the phone's recognizer proves unusable, this screen keeps using the desktop one.
  const [nativeBroken, setNativeBroken] = useState(false)
  const desktopDictation = useDesktopDictation(onText, language, onPartial)
  const desktopToggle = useRef(desktopDictation.toggle)
  useEffect(() => {
    desktopToggle.current = desktopDictation.toggle
  }, [desktopDictation.toggle])
  const handleUnavailable = useCallback(() => {
    setNativeBroken(true)
    // Picks up the press the person already made.
    setTimeout(() => desktopToggle.current(), 0)
  }, [])
  const nativeDictation = useNativeDictation(onText, language, onPartial, handleUnavailable)
  return mode === 'native' && getNativeSpeech() && !nativeBroken ? nativeDictation : desktopDictation
}
