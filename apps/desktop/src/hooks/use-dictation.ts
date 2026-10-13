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
 * Ditado por voz no input: abre o microfone, manda o áudio em PCM16 para o
 * motor do main e devolve o texto (provisório e final).
 *
 * O contrato do IPC é fixo e vive no processo principal:
 *   invoke "voice:stt:start" { engine, modelId?, language?, sampleRate, threads?, live } -> { id }
 *   invoke "voice:stt:push"  { id, pcm: base64 PCM16 }
 *   invoke "voice:stt:stop"  { id } -> { text, audioMs, ms }
 *   invoke "voice:stt:cancel" { id }
 *   evento "voice:stt:partial" -> { id, text }
 *
 * Duas regras que o laboratório de voz pagou para aprender (vozlab §13/§14):
 * o microfone é sempre solto e o AudioContext sempre fechado, aconteça o que
 * acontecer no meio da captura; e o AudioContext nasce dentro do gesto do
 * usuário, senão em alguns motores ele nasce suspenso e o grafo nunca roda.
 */

const CHANNELS = {
  start: "voice:stt:start",
  push: "voice:stt:push",
  stop: "voice:stt:stop",
  cancel: "voice:stt:cancel",
  partial: "voice:stt:partial",
} as const

/** Espera pelo `flush` do worklet ao soltar o botão: sem isso o resto do bloco
 *  de 1024 quadros (~64 ms) ficaria no processor e a última sílaba se perderia. */
const FLUSH_WAIT_MS = 40

interface Capture {
  sessionId: string
  ctx: AudioContext
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  sink: GainNode
  /** Blocos do worklet ainda não enviados (agrupados em pedaços de ~128 ms). */
  pending: Int16Array[]
  frames: number
}

export interface DictationCallbacks {
  /** Texto provisório do motor (a preferência `live` decide se vai para o input). */
  onPartial?: (text: string) => void
  /** Fim da captura. Vem vazio quando ninguém falou — quem mostrou provisório
   *  usa isso para devolver o input ao que era. */
  onFinal?: (text: string) => void
  /** Nível (0..1) de cada bloco do microfone (~64 ms) — alimenta a onda. */
  onLevel?: (level: number) => void
}

export interface Dictation {
  settings: VoiceSttSettings
  /** Microfone aberto, capturando. */
  listening: boolean
  /** Permissão/motor a caminho — o botão já pode se mostrar ativo. */
  starting: boolean
  error: string | null
  dismissError: () => void
  start: () => Promise<void>
  stop: () => Promise<void>
  cancel: () => void
}

/** Envia o que está acumulado como um pedaço PCM16 (base64). */
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
 * Solta a faixa e fecha o AudioContext — SEMPRE, inclusive quando o motor
 * troca, a permissão é negada ou o componente desmonta. Microfone pendurado é
 * o defeito documentado do laboratório (a captura seguinte vinha muda).
 */
function releaseCapture(capture: Capture) {
  capture.pending = []
  capture.frames = 0
  capture.node.port.onmessage = null
  capture.source.disconnect()
  capture.node.disconnect()
  capture.sink.disconnect()
  for (const track of capture.stream.getTracks()) track.stop()
  // close() rejeita se o contexto já estava fechado — não é erro para nós.
  void capture.ctx.close().catch(() => {})
}

export function useDictation(
  callbacks: DictationCallbacks = {},
  /** Força preferências nesta captura (a chamada sempre quer o texto ao vivo). */
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
  // O botão pode ser solto antes de o microfone abrir: encerra assim que abrir.
  const stopRequestedRef = useRef(false)
  const callbacksRef = useRef(callbacks)
  useEffect(() => {
    callbacksRef.current = callbacks
  })

  // Parciais do motor: só interessam à captura em andamento (o id confere).
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

  /** Encerra a captura: solta o microfone, fecha o áudio e espera o texto final
   *  (ou cancela a sessão, sem texto). */
  const finish = useCallback(async (capture: Capture, cancel = false) => {
    captureRef.current = null
    sessionIdRef.current = null
    setListening(false)
    try {
      capture.node.port.postMessage("flush")
      await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS))
      await pushPending(capture)
    } catch {
      // O main pode ter caído no meio: o texto que vier ainda serve.
    }
    // Microfone fechado ANTES de esperar a transcrição: o motor não precisa
    // dele e a faixa aberta atrapalha o próximo uso (e assusta o usuário).
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
      // Sem texto final, o provisório que já está no input fica: melhor o
      // usuário corrigir o que viu do que o texto sumir da tela.
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const start = useCallback(async () => {
    if (captureRef.current || startingRef.current) return
    if (!voice.enabled || !dictationSupported()) return
    const ipc = window.ipcRenderer
    stopRequestedRef.current = false
    startingRef.current = true
    setStarting(true)
    setError(null)

    let ctx: AudioContext | null = null
    let stream: MediaStream | null = null
    let sessionId: string | null = null
    try {
      // 1) O AudioContext nasce DENTRO do gesto (o pointerdown do botão) e é
      //    retomado na hora: fora do gesto ele pode nascer suspenso e aí o
      //    worklet nunca roda — a "gravação" ficaria muda (vozlab §14).
      ctx = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE })
      if (ctx.state === "suspended") await ctx.resume()
      if (ctx.state !== "running") throw new Error("audio-context-nao-rodou")

      // 2) Sessão no motor antes de abrir o microfone: modelo não baixado falha
      //    aqui, sem ninguém segurando a faixa.
      const started = (await ipc.invoke(CHANNELS.start, {
        engine: voice.engine,
        modelId: voice.modelId ?? undefined,
        language: voice.language,
        sampleRate: ctx.sampleRate,
        threads: voice.threads,
        live: voice.live,
      })) as { id?: unknown } | undefined
      if (!started || typeof started.id !== "string") throw new Error("voice:stt:start sem id")
      sessionId = started.id

      // 3) Microfone e worklet
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      await ctx.audioWorklet.addModule(pcmWorkletUrl(document.baseURI))
      const node = new AudioWorkletNode(ctx, PCM_WORKLET_PROCESSOR)
      const source = ctx.createMediaStreamSource(stream)
      const sink = ctx.createGain()
      // O ganho 0 no destino mantém o grafo sendo puxado (sem isso o worklet
      // não é chamado) sem devolver o microfone nos alto-falantes.
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
      // A captura começou: libera a trava de start ANTES de esperar a
      // transcrição, senão um novo ditado ficaria bloqueado por ~1 s.
      startingRef.current = false
      setStarting(false)
      setListening(true)

      if (stopRequestedRef.current) {
        stopRequestedRef.current = false
        await finish(capture)
      }
    } catch (err) {
      // Falhou no meio: nem sessão pendurada no main, nem microfone aberto.
      if (sessionId) {
        void Promise.resolve(ipc.invoke(CHANNELS.cancel, { id: sessionId })).catch(() => {})
      }
      sessionIdRef.current = null
      if (stream) for (const track of stream.getTracks()) track.stop()
      if (ctx) void ctx.close().catch(() => {})
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }, [finish, voice])

  const stop = useCallback(async () => {
    const capture = captureRef.current
    if (!capture) {
      // Soltou antes de a captura existir: quem terminar o start encerra.
      stopRequestedRef.current = true
      return
    }
    await finish(capture)
  }, [finish])

  const cancel = useCallback(() => {
    stopRequestedRef.current = false
    const capture = captureRef.current
    if (!capture) return
    void finish(capture, true)
  }, [finish])

  // Desmontou no meio da fala (troca de chat, fechou o painel): libera o
  // microfone e cancela a sessão, sem esperar texto.
  useEffect(
    () => () => {
      const capture = captureRef.current
      captureRef.current = null
      sessionIdRef.current = null
      if (!capture) return
      releaseCapture(capture)
      void Promise.resolve(window.ipcRenderer.invoke(CHANNELS.cancel, { id: capture.sessionId })).catch(() => {})
    },
    [],
  )

  // A persona fica em "listening" enquanto se grava — desde o instante da pressão
  // (`starting`), que é quando o usuário já entende que está falando. O estado é
  // global porque a persona vive em outro ramo da árvore (stores/voice-activity).
  useEffect(() => {
    useVoiceActivity.getState().setListening(listening || starting)
  }, [listening, starting])
  useEffect(() => () => useVoiceActivity.getState().setListening(false), [])

  /** Some com o aviso de erro (o botão volta ao normal sem nova tentativa). */
  const dismissError = useCallback(() => setError(null), [])

  return { settings: voice, listening, starting, error, start, stop, cancel, dismissError }
}
