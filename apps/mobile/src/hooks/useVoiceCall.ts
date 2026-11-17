/**
 * Call mode on the phone — the desktop is the server.
 *
 *   listening → the microphone records PCM (the same capture as the desktop-mode dictation). The
 *               phone judges the silence itself, with the same rules as the desktop
 *               (`isSpeech` / `turnEnded` from @orbit/shared): a `voice.call.silenceMs` quiet after
 *               some speech ends the turn.
 *   thinking  → the recording goes to the desktop (`/api/voice/transcribe`) and the text is sent as
 *               a message with `voiceCall`, which asks the agent for a short, speakable answer.
 *   speaking  → the answer is read sentence by sentence while it streams: each sentence goes to
 *               `/api/voice/speak` and the WAVs play in order. Then it goes back to listening.
 *
 * Half-duplex on purpose, as on the desktop: the microphone is closed while the agent talks,
 * otherwise it would hear itself. "Interrupt" cuts the speech and hands the turn back.
 *
 * The decisions about WHAT to say (`callSpeech`, `takeSpeakable`, `speechText`) are the desktop's own
 * functions, shared through @orbit/shared — a turn must sound the same on both.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { setAudioModeAsync } from 'expo-audio'
import {
  VOICE_DEFAULTS,
  callSpeech,
  isSpeech,
  speechText,
  takeSpeakable,
  trackNoise,
  turnEnded,
} from '@orbit/shared'

import { createCallSpeaker, type CallSpeaker } from '~/lib/call-speaker'
import { errorCodeFromHttpError } from '~/lib/http-error'
import i18n from '~/i18n'
import { useConnectionStore } from '~/stores/connection-store'
import { useSessionStore } from '~/stores/session-store'
import { useDesktopDictation, type DictationLevels } from './useDictation'
import type { MutableRefObject } from 'react'

export type CallPhase = 'listening' | 'thinking' | 'speaking'

/** How often the silence is judged. */
const VAD_INTERVAL_MS = 80
/** A level older than this is not "now" (the capture stalled): it counts as no information. */
const LEVEL_STALE_MS = 600

interface ReplyState {
  /** When the message went out: the answer is the assistant message created after it. */
  sentAt: number
  /** How far into the answer text has already gone to the speech. */
  offset: number
  /** The speech of this answer has started. */
  streaming: boolean
  /** The agent moved on to tools: the narration from there on is not spoken. */
  toolSeen: boolean
  done: boolean
  /** Interrupted (or no answer expected): nothing more is read. */
  ignore: boolean
  /** The turn was busy at least once — only then does `idle` mean finished. */
  sawBusy: boolean
}

const idleReply = (): ReplyState => ({
  sentAt: 0,
  offset: 0,
  streaming: false,
  toolSeen: false,
  done: true,
  ignore: true,
  sawBusy: false,
})

/** Speech error codes that make the call useless (the rest only skip a sentence). */
const FATAL_SPEAK_ERRORS: Record<string, string> = {
  tts_disabled: 'voice.tts.errorDisabled',
  voice_unavailable: 'voice.tts.errorUnavailable',
}

/** The line shown above the composer: what the person is saying, or what the agent is saying. */
export interface CallCaption {
  who: 'you' | 'agent'
  text: string
}

export interface VoiceCall {
  active: boolean
  phase: CallPhase
  /** Why the call dropped, readable. Cleared by `dismissError` or the next `start`. */
  error: string | null
  /** What the person said in the current turn (shown while the answer is being worked on). */
  heard: string
  /** Words as they come: yours while listening, the agent's sentence by sentence while it speaks. */
  caption: CallCaption | null
  levels: MutableRefObject<DictationLevels>
  start: () => void
  hangUp: () => void
  /** Cuts the speech (or the wait) and gives the turn back to the person. */
  interrupt: () => void
  dismissError: () => void
}

export function useVoiceCall({
  sessionId,
  submit,
  silenceMs = VOICE_DEFAULTS.call.silenceMs,
}: {
  sessionId?: string | null
  /** Sends what was said; `false` = it could not be sent (the call ends). */
  submit: (text: string) => boolean
  silenceMs?: number
}): VoiceCall {
  const [active, setActive] = useState(false)
  const [phase, setPhaseState] = useState<CallPhase>('listening')
  const [error, setError] = useState<string | null>(null)
  const [heard, setHeard] = useState('')
  const [caption, setCaption] = useState<CallCaption | null>(null)

  const activeRef = useRef(false)
  const phaseRef = useRef<CallPhase>('listening')
  const replyRef = useRef<ReplyState>(idleReply())
  const vadRef = useRef({ heard: false, lastSpeechAt: 0, ending: false, noise: 0 })
  const speakerRef = useRef<CallSpeaker | null>(null)
  const submitRef = useRef(submit)
  const hangUpRef = useRef<() => void>(() => {})
  const listenRef = useRef<() => void>(() => {})
  // Ends the call showing why.
  const failRef = useRef<(reason: string) => void>(() => {})

  const setPhase = useCallback((next: CallPhase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])

  // The transcript of a turn: it goes out as a message and the call waits for the answer.
  const handleText = useCallback(
    (text: string) => {
      if (!activeRef.current || phaseRef.current !== 'thinking') return
      setHeard(text)
      setCaption({ who: 'you', text })
      replyRef.current = {
        sentAt: Date.now(),
        offset: 0,
        streaming: false,
        toolSeen: false,
        done: false,
        ignore: false,
        sawBusy: false,
      }
      if (!submitRef.current(text)) {
        setError(i18n.t('promptInput.voice.failed'))
        hangUpRef.current()
      }
    },
    [],
  )
  // Your words show up as you speak (the desktop transcribes the tail of the recording every ~1.6s).
  const handlePartial = useCallback((text: string) => {
    if (!activeRef.current || phaseRef.current !== 'listening') return
    setCaption(text ? { who: 'you', text } : null)
  }, [])
  const dictation = useDesktopDictation(handleText, undefined, handlePartial)
  const dictationRef = useRef(dictation)

  useEffect(() => {
    submitRef.current = submit
    dictationRef.current = dictation
  })

  /** Opens the microphone for a new turn. */
  const listen = useCallback(() => {
    if (!activeRef.current) return
    vadRef.current = { heard: false, lastSpeechAt: 0, ending: false, noise: 0 }
    setCaption(null)
    setPhase('listening')
    const current = dictationRef.current
    if (!current.recording && !current.transcribing) current.toggle()
  }, [setPhase])
  useEffect(() => {
    listenRef.current = listen
  }, [listen])

  const ensureSpeaker = useCallback((): CallSpeaker => {
    if (speakerRef.current) return speakerRef.current
    const speaker = createCallSpeaker({
      speak: (text) => {
        const http = useConnectionStore.getState().http
        if (!http) return Promise.resolve({ ok: false, error: 'offline' })
        return http.speak(text)
      },
      onError: (code) => {
        const key = FATAL_SPEAK_ERRORS[errorCodeFromHttpError(code) ?? '']
        if (!key || !activeRef.current) return
        setError(i18n.t(key))
        hangUpRef.current()
      },
      // The last sentence finished: the turn goes back to the person.
      onSentence: (text) => {
        if (!activeRef.current) return
        // The agent's words build up as the sentences play; only the last few lines stay on screen.
        setCaption((current) => {
          const previous = current?.who === 'agent' ? current.text : ''
          return { who: 'agent', text: (previous ? previous + ' ' : '') + text }
        })
      },
      onDrained: () => {
        replyRef.current.streaming = false
        listenRef.current()
      },
    })
    speakerRef.current = speaker
    return speaker
  }, [])

  // Silence detection: judged on the microphone level, while listening.
  const recording = dictation.recording
  useEffect(() => {
    if (!active || phase !== 'listening' || !recording) return
    const timer = setInterval(() => {
      if (!activeRef.current || phaseRef.current !== 'listening') return
      const levels = dictationRef.current.levels.current
      const now = performance.now()
      if (levels.db === undefined || Date.now() - levels.at > LEVEL_STALE_MS) return
      const vad = vadRef.current
      if (isSpeech(levels.db, vad.heard, vad.noise)) {
        vad.heard = true
        vad.lastSpeechAt = now
      } else if (!vad.heard) {
        vad.noise = trackNoise(vad.noise, levels.db)
      } else if (!vad.ending && turnEnded({ heardSpeech: vad.heard, lastSpeechAt: vad.lastSpeechAt, now, silenceMs })) {
        vad.ending = true
        setPhase('thinking')
        // Stopping the recording sends it to the desktop; `handleText` gets the text.
        dictationRef.current.toggle()
      }
    }, VAD_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [active, phase, recording, silenceMs, setPhase])

  // The answer: read as it arrives.
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] : undefined))
  const status = useSessionStore((s) => (sessionId ? s.status[sessionId] : undefined))
  useEffect(() => {
    if (!active || phaseRef.current === 'listening') return
    const reply = replyRef.current
    if (reply.ignore) return
    const message = messages
      ?.slice()
      .reverse()
      // A compaction summary is written as an assistant message in the middle of the turn: not the answer.
      .find((item) => item.role === 'assistant' && !item.summary && item.createdAt >= reply.sentAt)
    if (status === 'submitted' || status === 'streaming' || status === 'fallback') reply.sawBusy = true
    const finished = reply.sawBusy && (status === 'idle' || status === 'error')
    if (!message) {
      // Failed before any answer: the turn goes back to the person.
      if (finished && status === 'error') {
        reply.done = true
        setError(i18n.t('promptInput.voice.failed'))
        listenRef.current()
      }
      return
    }
    const speaker = ensureSpeaker()
    const speech = callSpeech(message)
    const say = (raw: string) => {
      const spoken = speechText(raw)
      if (!spoken) return
      if (!reply.streaming) {
        reply.streaming = true
        setPhase('speaking')
      }
      speaker.say(spoken)
    }
    if (!reply.toolSeen) {
      const { chunk, next } = takeSpeakable(speech.lead, reply.offset, finished && !speech.hasTool)
      reply.offset = next
      if (chunk) say(chunk)
    }
    if (speech.hasTool && !reply.toolSeen) {
      // Moved on to the tools: the waiting sentence stays, the narration behind it leaves.
      reply.toolSeen = true
      if (reply.streaming) speaker.trim()
    }
    if (finished && !reply.done) {
      reply.done = true
      if (speech.hasTool && speech.final) say(speech.final)
      // With the speech open it ends when the rest plays (`onDrained` gives the turn back);
      // with nothing to say the turn comes back right away.
      if (reply.streaming) speaker.end()
      else listenRef.current()
    }
  }, [active, messages, status, ensureSpeaker, setPhase])

  // The recording had nothing in it (silence, a cough): not a failure of the call, listen again.
  // Anything else (offline, engine without a model) ends the call showing the reason.
  useEffect(() => {
    if (!active || !dictation.error) return
    const benign = [i18n.t('promptInput.voice.empty'), i18n.t('promptInput.voice.noSpeech')]
    if (benign.includes(dictation.error)) {
      dictationRef.current.clearError()
      listenRef.current()
      return
    }
    failRef.current(dictation.error)
  }, [active, dictation.error])

  const start = useCallback(() => {
    if (activeRef.current) return
    activeRef.current = true
    setActive(true)
    setError(null)
    setHeard('')
    replyRef.current = idleReply()
    dictationRef.current.clearError()
    dictationRef.current.cancel()
    // Recording and playback in the same session, with the sound out loud even on silent.
    void setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true }).catch(() => {})
    listen()
  }, [listen])

  const interrupt = useCallback(() => {
    if (!activeRef.current) return
    replyRef.current.ignore = true
    replyRef.current.streaming = false
    speakerRef.current?.stop()
    listen()
  }, [listen])

  const hangUp = useCallback(() => {
    if (!activeRef.current) return
    activeRef.current = false
    setActive(false)
    replyRef.current = idleReply()
    speakerRef.current?.stop()
    dictationRef.current.cancel()
    setPhase('listening')
    setHeard('')
    setCaption(null)
    void setAudioModeAsync({ allowsRecording: false }).catch(() => {})
  }, [setPhase])
  useEffect(() => {
    hangUpRef.current = hangUp
    failRef.current = (reason) => {
      setError(reason)
      hangUp()
    }
  }, [hangUp])

  // Leaving the screen in the middle of the call turns everything off.
  useEffect(
    () => () => {
      hangUpRef.current()
      speakerRef.current?.release()
      speakerRef.current = null
    },
    [],
  )

  const dismissError = useCallback(() => setError(null), [])

  return { active, phase, error, heard, caption, levels: dictation.levels, start, hangUp, interrupt, dismissError }
}
