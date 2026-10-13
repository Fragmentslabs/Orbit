import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { VOICE_DEFAULTS } from "@shared/voice"
import type { WaveLevels } from "@/src/components/dictation-wave"
import { useDictation } from "@/src/hooks/use-dictation"
import { readTtsEngine, readTtsPrefs, useSpeak } from "@/src/hooks/use-speak"
import { callSpeech, isSpeech, trackNoise, speechText, takeSpeakable, turnEnded } from "@/src/lib/voice-call"
import { useAppSettings } from "@/src/stores/app-settings"
import { useSessionStatus, useSessionStore } from "@/src/stores/session-store"
import { useVoiceActivity } from "@/src/stores/voice-activity"

/**
 * Modo chamada: conversa por voz em tempo real, em turnos.
 *
 *   ouvindo  → o ditado capta com texto ao vivo (prévia); um silêncio de
 *              `voice.call.silenceMs` depois de alguma fala encerra a vez.
 *   pensando → a transcrição vai como mensagem (com `voiceCall`, que pede ao
 *              agente uma resposta curta e falada).
 *   falando  → a resposta é lida FRASE A FRASE enquanto chega em streaming; ao
 *              terminar de ler, volta a ouvir.
 *
 * Meio-duplex de propósito: o microfone fica fechado enquanto o agente fala,
 * senão ele ouviria a própria voz pelos alto-falantes. Para cortar a fala, a
 * pessoa toca em "interromper" (volta a ouvir na hora).
 */

export type CallPhase = "listening" | "thinking" | "speaking"

interface ReplyState {
  /** Quando a mensagem foi enviada: a resposta é a do assistente criada depois. */
  sentAt: number
  /** Até onde do texto da resposta já foi para a fala. */
  offset: number
  /** A fala contínua desta resposta já foi aberta. */
  streaming: boolean
  /** O agente já partiu para as ferramentas: a narração dali em diante não é falada. */
  toolSeen: boolean
  done: boolean
  /** Interrompida: o resto da resposta não é lido. */
  ignore: boolean
  /** O turno já ficou ocupado: só depois disso um `idle` quer dizer "terminou"
   *  (logo após o envio a mensagem pode existir vazia com o status ainda idle). */
  sawBusy: boolean
}

const idleReply = (): ReplyState => ({ sentAt: 0, offset: 0, streaming: false, toolSeen: false, done: true, ignore: true, sawBusy: false })

export function useVoiceCall({
  sessionId,
  submit,
}: {
  sessionId?: string
  /** Envia o que foi dito; `false` = não deu para enviar (a chamada encerra). */
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
  /** Frases da resposta, na ordem em que foram para a fala (o `seg` de cada uma). */
  const [sentences, setSentences] = useState<string[]>([])
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

  // Os callbacks do ditado precisam do `listen`, que precisa do ditado: a
  // volta passa por refs (o hook do ditado guarda os callbacks num ref também).
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
    setPartial(text)
    // Texto ao vivo é prova de fala, mesmo que o nível tenha ficado baixo: cada
    // palavra nova que o motor reconhece adia o fim da vez (fala baixa, final
    // de frase arrastado, respiração no meio).
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
      // Ninguém falou nada de aproveitável: segue ouvindo.
      if (!said) {
        setTimeout(() => listenRef.current(), 0)
        return
      }
      setHeard(said)
      setSentences([])
      replyRef.current = { sentAt: Date.now(), offset: 0, streaming: false, toolSeen: false, done: false, ignore: false, sawBusy: false }
      setPhase("thinking")
      if (!submitRef.current(said)) hangUpRef.current()
    },
    [setPhase],
  )

  const dictation = useDictation({ onPartial, onFinal, onLevel }, { live: true })
  const dictationRef = useRef(dictation)
  dictationRef.current = dictation

  const { speakStream, appendSpeech, endSpeech, trimSpeech, stop: stopSpeaking, speaking, segmentText, audible } = useSpeak()

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

  /** A resposta inteira já foi dita (ou não havia o que dizer): a vez volta para a pessoa. */
  const backToListening = useCallback(() => {
    const reply = replyRef.current
    reply.ignore = true
    reply.streaming = false
    listen()
  }, [listen])

  // A fala contínua terminou de tocar (ou falhou): volta a ouvir.
  const wasSpeakingRef = useRef(false)
  useEffect(() => {
    const reply = replyRef.current
    if (wasSpeakingRef.current && !speaking && activeRef.current && reply.streaming && !reply.ignore) backToListening()
    wasSpeakingRef.current = speaking
  }, [speaking, backToListening])

  // A resposta chegando: corta em frases e anexa à fala contínua — o main gera
  // a frase seguinte enquanto a anterior toca, sem silêncio entre elas.
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] : undefined))
  const status = useSessionStatus(sessionId)
  useEffect(() => {
    if (!active || phaseRef.current === "listening") return
    const reply = replyRef.current
    if (reply.ignore) return
    const message = messages
      ?.slice()
      .reverse()
      .find((item) => item.role === "assistant" && item.createdAt >= reply.sentAt)
    if (status === "submitted" || status === "streaming" || status === "fallback") reply.sawBusy = true
    const finished = reply.sawBusy && (status === "idle" || status === "error")
    if (!message) {
      // Falhou antes de qualquer resposta: avisa e devolve a vez.
      if (finished && status === "error") {
        setError("reply")
        reply.done = true
        backToListening()
      }
      return
    }
    // Política de fala (ver `callSpeech`): o começo da resposta vai na hora;
    // com ferramentas, a narração do meio fica de fora e a resposta final vai
    // quando o turno termina.
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
      setSentences((prev) => [...prev, spoken])
    }
    if (!reply.toolSeen) {
      const { chunk, next } = takeSpeakable(speech.lead, reply.offset, finished && !speech.hasTool)
      reply.offset = next
      if (chunk) say(chunk)
    }
    if (speech.hasTool && !reply.toolSeen) {
      // Partiu para as ferramentas: fica a frase de espera (a que está tocando,
      // ou a primeira); o resto do que ele narrou antes — às vezes o próprio
      // raciocínio — sai da fila, gerado ou não.
      reply.toolSeen = true
      if (reply.streaming) trimSpeech()
    }
    if (finished && !reply.done) {
      reply.done = true
      if (speech.hasTool && speech.final) say(speech.final)
      // Com fala aberta, ela termina ao tocar o resto (o efeito acima devolve a
      // vez); sem nada para dizer, a vez volta já.
      if (reply.streaming) endSpeech()
      else backToListening()
    }
  }, [active, messages, status, backToListening, setPhase, speakStream, appendSpeech, endSpeech, trimSpeech, ttsPrefs, ttsEngine])

  // O ditado falhou no meio da chamada: encerra mostrando o motivo.
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
    setSentences([])
    replyRef.current = idleReply()
    // Um erro de um ditado anterior derrubaria a chamada logo ao começar.
    dictationRef.current.dismissError()
    useVoiceActivity.getState().setInCall(true)
    listen()
  }, [listen])

  /** Corta a fala (ou a espera) e devolve a vez para a pessoa. */
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

  // Saiu da tela no meio da chamada: desliga tudo.
  useEffect(() => () => hangUpRef.current(), [])

  return {
    active,
    phase,
    /** Texto ao vivo do que a pessoa está dizendo agora. */
    partial,
    /** O último turno da pessoa, como foi enviado. */
    heard,
    /** A frase da resposta que está tocando agora (ou a última, se ainda não começou). */
    saying: segmentText ?? sentences[0] ?? "",
    /** Falando, mas sem som neste instante: o agente ainda trabalha na próxima frase. */
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
