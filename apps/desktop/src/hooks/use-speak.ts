import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { VoiceTtsEngine } from "@shared/voice"
import { parseVoiceStatus, type VoiceStatus } from "@/src/lib/dictation"
import { voiceApi } from "@/src/lib/voice-ipc"
import { useVoiceActivity } from "@/src/stores/voice-activity"

/**
 * FALAR: pede a síntese ao main (`voice:tts:*`) e toca os pedaços PCM16 em
 * sequência, emendando um no outro.
 *
 * O áudio chega em streaming — cada pedaço é agendado como um
 * AudioBufferSourceNode no mesmo AudioContext, com o início no fim do
 * anterior. Não há <audio> nem blob por pedaço: montar um blob por chunk
 * introduziria uma pausa audível entre eles.
 */

/** Taxa dos pedaços do motor (mesma que o main manda em `sr`). */
export const TTS_SAMPLE_RATE = 24000

/** Canais da fala (`voice:tts:*`); o `voice:status` sai do `voiceApi`. */
const CHANNEL = {
  start: "voice:tts:start",
  chunk: "voice:tts:chunk",
  done: "voice:tts:done",
  cancel: "voice:tts:cancel",
} as const

/** Folga entre pedaços que chegam atrasados e o agendamento em si. */
const SCHEDULE_LEAD_SECONDS = 0.02

/** Quanto esperar, depois do fim previsto do áudio agendado, por um `done`. */
const DONE_GRACE_SECONDS = 5

/** Preferências de voz (bloco `voice.tts` do AppSettings) já resolvidas. */
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
  /** Prioridade de áudio desta fala; sem ela, vale a das configurações. */
  engine?: VoiceTtsEngine
}

/** O que o main manda em `voice:tts:chunk`. */
interface ChunkPayload {
  id?: string
  pcm?: string
  sr?: number
  i?: number
  n?: number
}

/** O que o main manda em `voice:tts:done` (com `error` quando a síntese falhou). */
interface DonePayload {
  id?: string
  error?: string
}

/**
 * Lê o bloco `voice.tts` de forma defensiva: o tipo compartilhado pode ainda
 * não trazê-lo (chega em outro worker), e a UI não pode depender disso para
 * abrir. Sem nada no localStorage, valem os padrões do app.
 */
export function readTtsPrefs(voice: unknown): TtsPrefs {
  const tts = (voice as { tts?: Record<string, unknown> } | null | undefined)?.tts
  const text = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value : fallback
  return {
    enabled: typeof tts?.enabled === "boolean" ? tts.enabled : true,
    voice: text(tts?.voice, "F2"),
    lang: text(tts?.lang, "pt"),
    speed: typeof tts?.speed === "number" && tts.speed > 0 ? tts.speed : 1,
  }
}

/**
 * Prioridade de áudio do bloco `voice.tts`: `model` (rota pelo provedor, o
 * padrão) ou `local` (motor do Supertonic). Valor ausente ou fora do domínio
 * cai no padrão — a fala nunca fica sem motor.
 */
export function readTtsEngine(voice: unknown): VoiceTtsEngine {
  const engine = (voice as { tts?: { engine?: unknown } } | null | undefined)?.tts?.engine
  return engine === "local" ? "local" : "model"
}

/** base64 de PCM16LE -> amostras Float32 em -1..1. Entrada inválida vira vazio. */
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

/** Resposta de `voice:status` no que o botão precisa saber. */
export interface TtsStatus {
  ready: boolean
  /** `false` = ninguém respondeu (main antigo ou sem motor) — não bloqueia o botão. */
  known: boolean
}

/**
 * Interpreta o `voice:status` sem confiar na forma: só `ttsReady` é obrigatório.
 *
 * Com a prioridade em `model`, a rota do provedor (`modelTts.available`) já
 * destrava o botão mesmo sem o modelo local no disco — é essa metade que a
 * preferência acrescentou. Sem rota, vale a leitura local (o pipeline cai no
 * motor local, então é ele que manda no estado do botão).
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

/** Pede ao main que abandone a síntese. Best-effort: sem canal, não há o que fazer. */
function cancelRequest(id: string) {
  const call = window.ipcRenderer?.invoke(CHANNEL.cancel, { id })
  void Promise.resolve(call).catch(() => {})
}

export type AudioContextFactory = () => AudioContext

/**
 * Fila de reprodução: agenda os pedaços emendados e guarda o que ainda está
 * tocando. Vive fora do React (e recebe a fábrica de AudioContext de fora)
 * para poder ser testada com um AudioContext de mentira — o hook só cuida do
 * id da fala e do ciclo de vida.
 */
export class ChunkPlayer {
  onEnded: (() => void) | null = null
  private readonly createContext: AudioContextFactory
  private context: AudioContext | null = null
  private sources: AudioBufferSourceNode[] = []
  private nextAt = 0

  constructor(createContext: AudioContextFactory) {
    this.createContext = createContext
  }

  /** Cria o AudioContext sob demanda — no gesture do clique, quando possível. */
  ensure(): AudioContext {
    if (this.context && this.context.state !== "closed") return this.context
    this.context = this.createContext()
    return this.context
  }

  /** Fim do áudio já agendado, no relógio do contexto. */
  get scheduledEnd(): number {
    return this.nextAt
  }

  /** Relógio do contexto (0 se ele ainda nem existe). */
  get clock(): number {
    return this.context?.currentTime ?? 0
  }

  /** Pedaços agendados que ainda não chegaram ao fim. */
  get pending(): number {
    return this.sources.length
  }

  /** Agenda um pedaço emendado no fim do anterior. Um pedaço vazio não agenda nada. */
  schedule(samples: Float32Array, sampleRate: number): void {
    if (samples.length === 0) return
    const context = this.ensure()
    if (context.state === "suspended") void context.resume()
    const buffer = context.createBuffer(1, samples.length, sampleRate)
    buffer.getChannelData(0).set(samples)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    // Emenda no pedaço anterior; se a reprodução atrasou, volta para "agora".
    const at = Math.max(this.nextAt, context.currentTime + SCHEDULE_LEAD_SECONDS)
    source.start(at)
    this.nextAt = at + buffer.duration
    this.sources.push(source)
    source.onended = () => {
      this.sources = this.sources.filter((current) => current !== source)
      source.disconnect()
      this.onEnded?.()
    }
  }

  /** Interrompe o que está agendado — o que já tocou não volta atrás. */
  stopAll(): void {
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // Já tinha terminado sozinho.
      }
      source.disconnect()
    }
    this.sources = []
    this.nextAt = 0
  }

  /** Fecha o AudioContext: no unmount, para não deixar saída de áudio viva. */
  close(): void {
    this.stopAll()
    void this.context?.close().catch(() => {})
    this.context = null
  }
}

/**
 * A ponte mínima que o observador de estado precisa — o `voiceApi` real, na
 * prática, e uma ponte de mentira nos testes. Tipada por `unknown` de
 * propósito: quem lê o payload é que normaliza, não esta interface.
 */
export interface VoiceStatusSource {
  status: () => Promise<unknown>
  /** Assina o canal de mudança de estado e devolve o unsubscribe. */
  onStatusChanged: (listener: () => void) => () => void
}

export interface VoiceStatusSubscription {
  /** Relê `voice:status` sob demanda (o `focus` da janela usa isto). */
  read: () => void
  /** Cancela a assinatura do canal — sai no unmount, sem listener órfão. */
  unsubscribe: () => void
}

/**
 * Observa o estado de voz do main: lê `voice:status` agora e reconsulta a cada
 * `voice:status-changed`. Vive fora do React para poder ser testado com uma
 * ponte de mentira (mesmo motivo do `ChunkPlayer`).
 *
 * O evento é tratado como SINAL, não como a fonte da verdade: o payload pode
 * vir inteiro (retrato novo) ou só com o que mudou, e a semântica dos campos
 * ainda está mudando no main. Por isso o evento dispara uma nova consulta em
 * vez de ser interpretado aqui — quem lê o payload (`readTtsStatus` e
 * `parseVoiceStatus`) já tolera mapa por id, lista e `installed`/`downloaded`.
 *
 * Main que não respondeu (sem canal, erro, ponte quebrada) vira `undefined`:
 * ninguém é bloqueado por um status que não soubemos ler.
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

/** Estado de voz que a UI consome: o retrato do ditado e o do TTS. */
export interface VoiceStatusState {
  /** Payload normalizado para o `voiceTargetReady`; `null` = não deu para ler. */
  status: VoiceStatus | null
  /** O que o botão de fala precisa saber do TTS. */
  tts: TtsStatus
  /** Força uma nova consulta (os eventos já reconsultam sozinhos). */
  refresh: () => void
}

/**
 * Estado de voz reativo, compartilhado pelo botão de fala e pelo de ditado:
 * consulta `voice:status` ao montar e reconsulta a cada `voice:status-changed`
 * (download, extração, remoção, falha). O `focus` da janela fica só como
 * reforço — o download acontece nas Preferências, um modal DENTRO desta janela,
 * então o foco raramente dispara (era o bug: o botão só destravava ao remontar).
 *
 * `enabled: false` desliga tudo — nada de consulta nem de assinatura.
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

/** Estado do botão de fala para a prioridade de áudio escolhida. */
export function useTtsStatus(enabled: boolean, engine: VoiceTtsEngine = "model"): TtsStatus {
  return useVoiceStatus(enabled, engine).tts
}

/**
 * Hook de fala: `speak(texto)` sintetiza e toca, `stop()` interrompe. Só uma
 * fala por vez — um `speak` novo corta a anterior, e nada dela sobrevive.
 */
export function useSpeak() {
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const playerRef = useRef<ChunkPlayer | null>(null)
  const idRef = useRef<string | null>(null)
  /** `voice:tts:start` ainda não devolveu o id (pedaços podem ter chegado antes). */
  const awaitingRef = useRef(false)
  const earlyRef = useRef<ChunkPayload[]>([])
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

  /** Zera o estado da fala em curso (sem tocar no `error`). */
  const reset = useCallback(() => {
    clearGuard()
    getPlayer().stopAll()
    idRef.current = null
    awaitingRef.current = false
    earlyRef.current = []
    doneRef.current = false
    cancelledRef.current = false
    setSpeaking(false)
  }, [clearGuard, getPlayer])

  /** Fim normal: o áudio acabou e o main confirmou a fala. */
  const finish = useCallback(() => {
    reset()
  }, [reset])

  /** Fim com erro: corta o que estava agendado e avisa a UI. */
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
   * Rede de segurança para um `done` que nunca chega: dispara pouco depois do
   * fim do áudio já agendado, e é re-armada a cada pedaço (o prazo acompanha a
   * fila, então um bloco final longo não é cortado por ela).
   */
  const armGuard = useCallback(() => {
    const player = getPlayer()
    const seconds = Math.max(player.scheduledEnd - player.clock, 0) + DONE_GRACE_SECONDS
    clearGuard()
    guardRef.current = setTimeout(finish, seconds * 1000)
  }, [clearGuard, finish, getPlayer])

  const playChunk = useCallback(
    (chunk: ChunkPayload) => {
      const samples = decodePcm16(chunk.pcm ?? "")
      // Pedaço vazio não agenda nada — mas não pode quebrar o encadeamento.
      if (samples.length === 0) return
      const sampleRate = typeof chunk.sr === "number" && chunk.sr > 0 ? chunk.sr : TTS_SAMPLE_RATE
      getPlayer().schedule(samples, sampleRate)
      armGuard()
    },
    [armGuard, getPlayer],
  )

  useEffect(() => {
    const player = getPlayer()
    player.onEnded = maybeFinish
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
        // Chegou antes de o main devolver o id: guarda para tocar na ordem.
        if (awaitingRef.current && !cancelledRef.current) earlyRef.current.push(payload)
        return
      }
      if (payload.id !== id) return
      playChunk(payload)
    }

    const onDone = (...args: unknown[]) => {
      const payload = args[0] as DonePayload | undefined
      if (!payload || payload.id !== idRef.current) return
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
    // Também derruba um start ainda em voo: o id que voltar será cancelado.
    cancelledRef.current = true
    clearGuard()
    getPlayer().stopAll()
    idRef.current = null
    awaitingRef.current = false
    earlyRef.current = []
    doneRef.current = false
    setSpeaking(false)
    setError(null)
    if (id) cancelRequest(id)
  }, [clearGuard, getPlayer])

  const speak = useCallback(
    (text: string, request: SpeakRequest = {}) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const ipc = window.ipcRenderer
      if (!ipc) {
        setError("sem canal de voz")
        return
      }
      // Uma fala por vez: o clique repetido cai no stop() do botão.
      stop()
      // stop() marcou a fala como cancelada — esta é nova.
      cancelledRef.current = false
      setError(null)
      setSpeaking(true)
      awaitingRef.current = true
      // O contexto nasce no gesto do clique — é ele que libera o áudio no Chromium.
      try {
        void getPlayer().ensure().resume()
      } catch (reason) {
        finishWithError(reason instanceof Error ? reason.message : String(reason))
        return
      }

      void ipc
        .invoke(CHANNEL.start, {
          text: trimmed,
          voice: request.voice,
          lang: request.lang,
          speed: request.speed,
          engine: request.engine,
        })
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
          const early = earlyRef.current
          earlyRef.current = []
          for (const chunk of early) {
            if (chunk.id === id || chunk.id === undefined) playChunk(chunk)
          }
        })
        .catch((reason: unknown) => {
          finishWithError(reason instanceof Error ? reason.message : String(reason))
        })
    },
    [finishWithError, getPlayer, playChunk, stop],
  )

  // A persona reage ao áudio que está SAINDO, e ela vive em outro ramo da
  // árvore: o sinal vai por um store global (ver stores/voice-activity).
  useEffect(() => {
    useVoiceActivity.getState().setSpeaking(speaking)
  }, [speaking])
  useEffect(() => () => useVoiceActivity.getState().setSpeaking(false), [])

  // Desmontou: sem listeners (efeitos acima), sem fala pendente e sem AudioContext.
  useEffect(() => {
    return () => {
      const id = idRef.current
      idRef.current = null
      awaitingRef.current = false
      clearGuard()
      playerRef.current?.close()
      playerRef.current = null
      if (id) cancelRequest(id)
    }
  }, [clearGuard])

  return { speak, stop, speaking, error }
}
