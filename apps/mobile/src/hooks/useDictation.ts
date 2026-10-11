/**
 * Ditado no app companion: grava no aparelho e manda o áudio para o desktop
 * transcrever (o celular não roda modelo de voz).
 *
 * O microfone vem do `AudioStream` do expo-audio, que entrega PCM cru — então
 * não há arquivo nem codec no caminho: pedimos int16, mono, 16 kHz e enviamos
 * os buffers direto em base64 para `POST /api/voice/transcribe`. Se o hardware
 * não entregar exatamente 16 kHz, usamos a taxa que veio em cada buffer e
 * informamos essa taxa ao desktop (ele reamostra).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAudioStream, requestRecordingPermissionsAsync, type AudioStreamBuffer } from 'expo-audio'
import { useConnectionStore } from '~/stores/connection-store'
import { bytesToBase64, concatPcm, pcmDurationMs } from '~/lib/voice-pcm'
import i18n from '~/i18n'

const TARGET_SAMPLE_RATE = 16000

/** Abaixo disto é toque acidental no microfone, não fala — não vale transcrever. */
const MIN_AUDIO_MS = 200

export interface Dictation {
  /** Gravando agora (o botão vira "parar"). */
  recording: boolean
  /** Enviando o áudio e esperando o texto do desktop. */
  transcribing: boolean
  /** Falha visível ao usuário (permissão, offline, motor de voz indisponível). */
  error: string | null
  /** Começa a gravar; se já estiver gravando, para e transcreve. */
  toggle: () => void
  /** Limpa a mensagem de erro. */
  clearError: () => void
}

/** Erro do cliente HTTP no formato `"503: {...}"` → motivo legível do desktop. */
function reasonFromHttpError(error?: string): string | null {
  if (!error) return null
  const jsonStart = error.indexOf('{')
  if (jsonStart < 0) return null
  try {
    const parsed = JSON.parse(error.slice(jsonStart)) as { error?: string; reason?: string }
    return parsed.reason || parsed.error || null
  } catch {
    return null
  }
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
  // Um buffer que chega depois do stop (a captura para no meio de um pedaço)
  // seria gravado no ditado SEGUINTE: o flag fecha a porta na hora de parar.
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

  // Trocar de tela no meio da gravação não pode deixar o microfone aberto.
  useEffect(() => {
    return () => {
      try {
        stream?.stop()
      } catch {
        /* já parado */
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
      /* já parado */
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
        // 503 do desktop (motor indisponível / modelo não baixado) traz o motivo.
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
