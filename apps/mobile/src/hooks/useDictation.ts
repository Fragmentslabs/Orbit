/**
 * Dictation in the companion app: records on the device and sends the audio to the desktop
 * to transcribe (the phone does not run a voice model).
 *
 * The microphone comes from the `AudioStream` of expo-audio, which delivers raw PCM — so
 * there is no file and no codec in the path: we ask for int16, mono, 16 kHz and send
 * the buffers straight as base64 to `POST /api/voice/transcribe`. If the hardware
 * does not deliver exactly 16 kHz, we use the rate that came in each buffer and
 * report that rate to the desktop (it resamples).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAudioStream, requestRecordingPermissionsAsync, type AudioStreamBuffer } from 'expo-audio'
import { useConnectionStore } from '~/stores/connection-store'
import { bytesToBase64, concatPcm, pcmDurationMs } from '~/lib/voice-pcm'
import { reasonFromHttpError } from '~/lib/http-error'
import i18n from '~/i18n'

const TARGET_SAMPLE_RATE = 16000

/** Below this it is an accidental touch on the microphone, not speech — not worth transcribing. */
const MIN_AUDIO_MS = 200

export interface Dictation {
  /** Recording now (the button becomes "stop"). */
  recording: boolean
  /** Sending the audio and waiting for the text from the desktop. */
  transcribing: boolean
  /** Failure visible to the user (permission, offline, voice engine unavailable). */
  error: string | null
  /** Starts recording; if already recording, stops and transcribes. */
  toggle: () => void
  /** Clears the error message. */
  clearError: () => void
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

export function useDictation(onText: (text: string) => void, language?: string): Dictation {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const http = useConnectionStore((s) => s.http)
  const chunksRef = useRef<Uint8Array[]>([])
  const sampleRateRef = useRef(TARGET_SAMPLE_RATE)
  // A buffer that arrives after the stop (the capture stops in the middle of a chunk)
  // would be written into the NEXT dictation: the flag closes the door at stop time.
  const capturingRef = useRef(false)

  const handleBuffer = useCallback((buffer: AudioStreamBuffer) => {
    if (!capturingRef.current) return
    if (buffer.sampleRate > 0) sampleRateRef.current = buffer.sampleRate
    chunksRef.current.push(new Uint8Array(buffer.data))
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

  const start = useCallback(async () => {
    setError(null)
    if (!stream) {
      setError(i18n.t('promptInput.voice.unsupported'))
      return
    }
    try {
      const permission = await requestRecordingPermissionsAsync()
      if (!permission.granted) {
        setError(i18n.t('promptInput.voice.permission'))
        return
      }
      chunksRef.current = []
      sampleRateRef.current = TARGET_SAMPLE_RATE
      capturingRef.current = true
      await stream.start()
      setRecording(true)
    } catch (err) {
      capturingRef.current = false
      setRecording(false)
      setError(i18n.t('promptInput.voice.failed') + ': ' + messageOf(err))
    }
  }, [stream])

  const stop = useCallback(async () => {
    capturingRef.current = false
    try {
      stream?.stop()
    } catch {
      /* already stopped */
    }
    setRecording(false)

    const pcm = concatPcm(chunksRef.current)
    chunksRef.current = []
    const durationMs = pcmDurationMs(pcm.length, sampleRateRef.current)
    if (pcm.length === 0 || durationMs < MIN_AUDIO_MS) {
      setError(i18n.t('promptInput.voice.empty'))
      return
    }

    if (!http) {
      setError(i18n.t('promptInput.voice.offline'))
      return
    }

    setTranscribing(true)
    try {
      const res = await http.transcribePcm(bytesToBase64(pcm), sampleRateRef.current, { language })
      if (!res.ok) {
        // 503 from the desktop (engine unavailable / model not downloaded) carries the reason.
        setError(reasonFromHttpError(res.error) ?? i18n.t('promptInput.voice.failed'))
        return
      }
      const text = res.data?.text?.trim()
      if (text) onText(text)
      else setError(i18n.t('promptInput.voice.noSpeech'))
    } catch (err) {
      setError(i18n.t('promptInput.voice.failed') + ': ' + messageOf(err))
    } finally {
      setTranscribing(false)
    }
  }, [stream, http, language, onText])

  const toggle = useCallback(() => {
    if (transcribing) return
    if (recording) void stop()
    else void start()
  }, [recording, transcribing, start, stop])

  const clearError = useCallback(() => setError(null), [])

  return { recording, transcribing, error, toggle, clearError }
}
