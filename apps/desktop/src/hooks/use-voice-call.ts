import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { VOICE_DEFAULTS } from "@shared/voice"
import type { WaveLevels } from "@/src/components/dictation-wave"
import { useDictation } from "@/src/hooks/use-dictation"
import { readTtsEngine, readTtsPrefs, useSpeak } from "@/src/hooks/use-speak"
import {
  callSpeech,
  captionIndexAt,
  captionLines,
  isSpeech,
  normalizeSpeech,
  trackNoise,
  speechText,
  takeSpeakable,
  turnEnded,
} from "@/src/lib/voice-call"
import { useAppSettings } from "@/src/stores/app-settings"
import { useSessionStatus, useSessionStore } from "@/src/stores/session-store"
import { useVoiceActivity } from "@/src/stores/voice-activity"

/**
 * Call mode: voice conversation in real time, in turns.
 *
 *   listening → the dictation captures with live text (preview); a silence of
 *               `voice.call.silenceMs` after some speech ends the turn.
 *   thinking  → the transcription goes as a message (with `voiceCall`, which asks the
 *               agent for a short, spoken answer).
 *   speaking  → the answer is read SENTENCE BY SENTENCE as it arrives in streaming; when
 *               the reading ends, it goes back to listening.
 *
 * Half-duplex on purpose: the microphone stays closed while the agent speaks,
 * otherwise it would hear its own voice through the speakers. To cut the speech, the
 * person taps "interrupt" (it goes back to listening right away).
 */

export type CallPhase = "listening" | "thinking" | "speaking"

interface ReplyState {
  /** When the message was sent: the answer is the assistant one created after it. */
  sentAt: number
  /** How far into the answer text has already gone to the speech. */
  offset: number
  /** The continuous speech of this answer has already been opened. */
  streaming: boolean
  /** The agent has already moved on to the tools: the narration from there on is not spoken. */
  toolSeen: boolean
  done: boolean
  /** Interrupted: the rest of the answer is not read. */
  ignore: boolean
  /** The turn is already busy: only after that does an `idle` mean "finished"
   *  (right after sending, the message may exist empty with the status still idle). */
  sawBusy: boolean
}

const idleReply = (): ReplyState => ({ sentAt: 0, offset: 0, streaming: false, toolSeen: false, done: true, ignore: true, sawBusy: false })

export function useVoiceCall({
  sessionId,
  submit,
}: {
  sessionId?: string
  /** Sends what was said; `false` = could not send it (the call ends). */
  submit: (text: string) => boolean
}) {
  const voice = useAppSettings((s) => (s.settings as unknown as { voice?: { call?: { silenceMs?: number } } }).voice)
  const silenceMs = voice?.call?.silenceMs ?? VOICE_DEFAULTS.call.silenceMs
  const ttsPrefs = useMemo(() => readTtsPrefs(voice), [voice])
  const ttsEngine = useMemo(() => readTtsEngine(voice), [voice])

  const [active, setActive] = useState(false)
  const [phase, setPhaseState] = useState<CallPhase>("listening")
  const [partial, setPartial] = useState("")
  const [heard, setHeard] = useState("")
  const [error, setError] = useState<string | null>(null)

  const activeRef = useRef(false)
  const phaseRef = useRef<CallPhase>("listening")
  const vadRef = useRef({ heard: false, lastSpeechAt: 0, ending: false, noise: 0 })
  const levelsRef = useRef<WaveLevels>({ values: [], at: 0 })
  const replyRef = useRef<ReplyState>(idleReply())
  const submitRef = useRef(submit)
  submitRef.current = submit

  const setPhase = useCallback((next: CallPhase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])

  // The dictation callbacks need `listen`, which needs the dictation: the
  // round trip goes through refs (the dictation hook also keeps the callbacks in a ref).
  const listenRef = useRef<() => void>(() => {})
  const hangUpRef = useRef<() => void>(() => {})

  const onLevel = useCallback(
    (level: number) => {
      const levels = levelsRef.current
      levels.values.push(level)
      levels.at = performance.now()
      if (!activeRef.current || phaseRef.current !== "listening") return
      const vad = vadRef.current
      const now = performance.now()
      if (isSpeech(level, vad.heard, vad.noise)) {
        vad.heard = true
        vad.lastSpeechAt = now
      } else if (!vad.heard) {
        vad.noise = trackNoise(vad.noise, level)
      } else if (!vad.ending && turnEnded({ heardSpeech: vad.heard, lastSpeechAt: vad.lastSpeechAt, now, silenceMs })) {
        vad.ending = true
        void dictationRef.current.stop()
      }
    },
    [silenceMs],
  )

  const lastPartialRef = useRef("")
  const onPartial = useCallback((text: string) => {
    // Call ended: a late partial from a capture that was already cancelled.
    if (!activeRef.current) return
    setPartial(text)
    // Live text is proof of speech, even if the level stayed low: every
    // new word the engine recognizes postpones the end of the turn (low speech, drawn-out
    // sentence ending, breathing in the middle).
    if (text.trim() && text !== lastPartialRef.current) {
      const vad = vadRef.current
      vad.heard = true
      vad.lastSpeechAt = performance.now()
    }
    lastPartialRef.current = text
  }, [])

  const onFinal = useCallback(
    (text: string) => {
      if (!activeRef.current || phaseRef.current !== "listening") return
      const said = text.trim()
      setPartial("")
      // Nobody said anything usable: keep listening.
      if (!said) {
        setTimeout(() => listenRef.current(), 0)
        return
      }
      setHeard(said)
      replyRef.current = { sentAt: Date.now(), offset: 0, streaming: false, toolSeen: false, done: false, ignore: false, sawBusy: false }
      setPhase("thinking")
      if (!submitRef.current(said)) hangUpRef.current()
    },
    [setPhase],
  )

  const dictation = useDictation({ onPartial, onFinal, onLevel }, { live: true })
  const dictationRef = useRef(dictation)
  dictationRef.current = dictation

  const { speakStream, appendSpeech, endSpeech, trimSpeech, stop: stopSpeaking, speaking, segment, segSpokenText, beforeSegText, speechScript, audible } = useSpeak()

  const listen = useCallback(() => {
    if (!activeRef.current) return
    vadRef.current = { heard: false, lastSpeechAt: 0, ending: false, noise: 0 }
    lastPartialRef.current = ""
    levelsRef.current = { values: [], at: performance.now() }
    setPartial("")
    setPhase("listening")
    void dictationRef.current.start()
  }, [setPhase])
  listenRef.current = listen

  /** The whole answer has already been said (or there was nothing to say): the turn goes back to the person. */
  const backToListening = useCallback(() => {
    const reply = replyRef.current
    reply.ignore = true
    reply.streaming = false
    listen()
  }, [listen])

  // The continuous speech finished playing (or failed): back to listening.
  const wasSpeakingRef = useRef(false)
  useEffect(() => {
    const reply = replyRef.current
    if (wasSpeakingRef.current && !speaking && activeRef.current && reply.streaming && !reply.ignore) backToListening()
    wasSpeakingRef.current = speaking
  }, [speaking, backToListening])

  // The answer arriving: cut it into sentences and attach it to the continuous speech — main generates
  // the next sentence while the previous one plays, with no silence between them.
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] : undefined))
  const status = useSessionStatus(sessionId)
  useEffect(() => {
    if (!active || phaseRef.current === "listening") return
    const reply = replyRef.current
    if (reply.ignore) return
    const message = messages
      ?.slice()
      .reverse()
      // Compaction writes the summary as an assistant message, created in the
      // middle of the turn and before the answer: it is not the answer and is not spoken.
      .find((item) => item.role === "assistant" && !item.summary && item.createdAt >= reply.sentAt)
    if (status === "submitted" || status === "streaming" || status === "fallback") reply.sawBusy = true
    const finished = reply.sawBusy && (status === "idle" || status === "error")
    if (!message) {
      // Failed before any answer: warns and gives the turn back.
      if (finished && status === "error") {
        setError("reply")
        reply.done = true
        backToListening()
      }
      return
    }
    // Speech policy (see `callSpeech`): the beginning of the answer goes right away;
    // with tools, the narration in the middle stays out and the final answer goes
    // when the turn ends.
    const speech = callSpeech(message)
    const say = (raw: string) => {
      const spoken = speechText(raw)
      if (!spoken) return
      if (!reply.streaming) {
        reply.streaming = true
        setPhase("speaking")
        speakStream({ voice: ttsPrefs.voice, lang: ttsPrefs.lang, speed: ttsPrefs.speed, engine: ttsEngine })
      }
      appendSpeech(spoken)
    }
    if (!reply.toolSeen) {
      const { chunk, next } = takeSpeakable(speech.lead, reply.offset, finished && !speech.hasTool)
      reply.offset = next
      if (chunk) say(chunk)
    }
    if (speech.hasTool && !reply.toolSeen) {
      // Moved on to the tools: the waiting sentence stays (the one playing,
      // or the first one); the rest of what it narrated before — sometimes its own
      // reasoning — leaves the queue, generated or not. The subtitle follows the cut
      // because `useSpeak` drops the text of the sentences that left.
      reply.toolSeen = true
      if (reply.streaming) trimSpeech()
    }
    if (finished && !reply.done) {
      reply.done = true
      if (speech.hasTool && speech.final) say(speech.final)
      // With the speech open, it ends when the rest plays (the effect above gives the
      // turn back); with nothing to say, the turn comes back right away.
      if (reply.streaming) endSpeech()
      else backToListening()
    }
  }, [active, messages, status, backToListening, setPhase, speakStream, appendSpeech, endSpeech, trimSpeech, ttsPrefs, ttsEngine])

  // The dictation failed in the middle of the call: end it showing the reason.
  useEffect(() => {
    if (active && dictation.error) {
      setError(dictation.error)
      hangUpRef.current()
    }
  }, [active, dictation.error])

  const start = useCallback(() => {
    if (activeRef.current) return
    activeRef.current = true
    setActive(true)
    setError(null)
    setHeard("")
    replyRef.current = idleReply()
    // An error from a previous dictation would take the call down right at the start.
    dictationRef.current.dismissError()
    // Net: a capture that was left open (it should not have been) is discarded, otherwise
    // start() would reuse it — with the old text inside.
    dictationRef.current.cancel()
    useVoiceActivity.getState().setInCall(true)
    listen()
  }, [listen])

  /** Cuts the speech (or the wait) and gives the turn back to the person. */
  const interrupt = useCallback(() => {
    if (!activeRef.current) return
    replyRef.current.ignore = true
    replyRef.current.streaming = false
    stopSpeaking()
    listen()
  }, [listen, stopSpeaking])

  const hangUp = useCallback(() => {
    if (!activeRef.current) return
    activeRef.current = false
    setActive(false)
    replyRef.current = idleReply()
    stopSpeaking()
    dictationRef.current.cancel()
    setPartial("")
    setPhase("listening")
    useVoiceActivity.getState().setInCall(false)
  }, [setPhase, stopSpeaking])
  hangUpRef.current = hangUp

  // Left the screen in the middle of the call: turns everything off.
  useEffect(() => () => hangUpRef.current(), [])

  // The `end_call` tool (the agent heard "bye, Orbit") ends the conversation in
  // any window — including this one, which may be the main one or the overlay.
  // The event comes from main because the request is born from a tool, not from the UI.
  useEffect(() => {
    if (!window.ipcRenderer) return
    const wrapper = window.ipcRenderer.on("voice:hangup", () => hangUpRef.current())
    return () => window.ipcRenderer.off("voice:hangup", wrapper)
  }, [])

  // The speech subtitle follows the AUDIO, not the generation: the sentences already played
  // stay, and the one playing is revealed by the player clock. A 100 ms
  // tick is enough for the lines to come up along with the voice.
  const [, bumpSpeechFrame] = useReducer((frame: number) => frame + 1, 0)
  useEffect(() => {
    if (phase !== "speaking" || segment === null) return
    const timer = setInterval(bumpSpeechFrame, 100)
    return () => clearInterval(timer)
  }, [phase, segment])

  const saying = (() => {
    if (segment === null) return ""
    return [...beforeSegText(segment), segSpokenText(segment)].filter(Boolean).join(" ")
  })()

  // The two lines the panel shows: the one being said (the audio
  // point) and the next one, which has already been generated but has not played yet. The script has
  // the whole text, including that of the future sentences; `saying` gives the position.
  const caption = (() => {
    if (segment === null) return null
    const lines = captionLines(speechScript())
    if (lines.length === 0) return null
    return {
      lines: lines.map((line) => line.text),
      current: captionIndexAt(lines, normalizeSpeech(saying).length),
    }
  })()

  return {
    active,
    phase,
    /** Live text of what the person is saying now. */
    partial,
    /** The person's last turn, as it was sent. */
    heard,
    /** What has already been said of the answer, up to the audio point — the subtitle position. */
    saying,
    /** The two subtitle lines: the current one and the next. */
    caption,
    /** Speaking, but with no sound at this instant: the agent is still working on the next sentence. */
    waiting: phase === "speaking" && !audible,
    error,
    levels: levelsRef,
    listening: dictation.listening || dictation.starting,
    start,
    interrupt,
    hangUp,
    dismissError: useCallback(() => setError(null), []),
  }
}
