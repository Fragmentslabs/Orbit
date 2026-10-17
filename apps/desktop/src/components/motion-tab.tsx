import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  Box,
  ChevronDown,
  CircleCheck,
  Clapperboard,
  Film,
  ImageIcon,
  Layers,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Music,
  Pause,
  Play,
  Repeat,
  RotateCw,
  SkipBack,
  SkipForward,
  Type,
  X,
  type LucideIcon,
} from "lucide-react"
import { motionSeconds, motionTimecode } from "@shared/chat"
import { MOTION_SCHEME } from "@shared/media"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { IconAction } from "@/src/components/ai/artifact-part"
import { motionApi, windowApi, type MotionLayersResult, type MotionRenderFormat } from "@/src/lib/ipc"
import {
  MOTION_AUDIO_SEEK_S,
  motionAudioRate,
  motionTrackEnd,
  motionTrackIsLive,
} from "@/src/lib/motion-audio-range"
import { usePanelStore } from "@/src/stores/panel-store"
import { cn } from "@/lib/utils"

/**
 * Preview de uma composição de motion na aba do painel direito — o palco onde o
 * usuário acompanha, ao vivo, o agente editando a peça.
 *
 * O iframe carrega a PASTA registrada por `orbit-motion://<id>/<caminho>`; quem
 * injeta o runtime de seek é o próprio handler do scheme (video/motion-store),
 * então aqui não se injeta script nenhum — só se conversa com ele por
 * postMessage, com o campo `source: "orbit-motion"`:
 *
 *   iframe → painel: ready (formato e duração), time (quadro tocado), error,
 *                    assets (fontes que não carregaram)
 *   painel → iframe: seek(frame), play, pause, loop
 *
 * A unidade de tempo é QUADRO INTEIRO a 30 fps — a mesma do contrato do render,
 * para o que o usuário aprova aqui ser exatamente o que sai lá. Por isso o
 * transporte anda de quadro em quadro e o timecode é `mm:ss:ff`.
 *
 * Embaixo da régua, as CAMADAS: quem entra e sai de cena, e quando — medidas no
 * main numa janela offscreen (motion:layers), porque a composição é HTML livre e
 * não declara camada nenhuma. Clicar numa camada a leva junto com o quadro para
 * a nota do chat.
 *
 * O iframe roda em `sandbox="allow-scripts"` SEM `allow-same-origin` (origem
 * opaca: sem window do Orbit, sem cookies, sem storage), como o artefato. É
 * dessa origem opaca que vem o cuidado com a ponte: não há origem para
 * conferir, quem confere é o `event.source === contentWindow` do nosso iframe.
 */

/** fps do preview — constante do contrato (o runtime também assume 30). */
const FPS = 30

/** Marca das mensagens da ponte (ver MOTION_SOURCE no motion-runtime do main). */
const MOTION_SOURCE = "orbit-motion"

/** Formato do palco enquanto o runtime não anuncia o da composição. */
const DEFAULT_SPEC: MotionSpec = { width: 1920, height: 1080, durationInFrames: 0 }

/** Sem "ready" nesse tempo, a página não vai responder: diz por quê, em vez de girar. */
const LOAD_TIMEOUT_MS = 10_000

/** Fração da altura do painel que o palco pode ocupar — o resto é da linha de tempo. */
const STAGE_MAX_RATIO = 0.5
const STAGE_MAX_RATIO_FULLSCREEN = 0.62

interface MotionSpec {
  width: number
  height: number
  /** 0 = ainda não anunciado (a composição declara o comprimento). */
  durationInFrames: number
}

type MotionLayer = MotionLayersResult["layers"][number]

/**
 * O ícone de cada tipo de camada. O rótulo diz o NOME, não o que o elemento é —
 * um título e uma foto podem se chamar os dois de ".caption" —, então o tipo vem
 * medido do DOM pelo runtime e é o que diferencia dois elementos na lista.
 */
const LAYER_ICON: Record<MotionLayer["kind"], LucideIcon> = {
  text: Type,
  image: ImageIcon,
  video: Film,
  audio: Music,
  other: Box,
}

type RuntimeMessage =
  | { type: "ready"; durationInFrames: number; width: number; height: number; version: number }
  | { type: "time"; frame: number }
  | { type: "error"; message: string; stack?: string }
  | { type: "assets"; failedFonts: string[] }

type RenderState =
  | { status: "idle" }
  | { status: "running"; frame: number; total: number }
  | { status: "done"; path: string }
  | { status: "error"; message: string }

type LayersState =
  | { status: "idle" }
  | { status: "loading"; previous: MotionLayer[] }
  | { status: "ready"; layers: MotionLayer[] }
  | { status: "error"; message: string }

/**
 * Valida uma mensagem iframe → painel. Mesmas regras do parseMotionMessage do
 * runtime (que vive no main e não é importável daqui): o que não casa é
 * descartado em silêncio, porque a composição é conteúdo não confiável.
 */
function parseRuntimeMessage(raw: unknown): RuntimeMessage | null {
  if (!raw || typeof raw !== "object") return null
  const msg = raw as Record<string, unknown>
  if (msg.source !== MOTION_SOURCE) return null
  if (msg.type === "ready") {
    if (typeof msg.durationInFrames !== "number" || !Number.isFinite(msg.durationInFrames)) return null
    return {
      type: "ready",
      durationInFrames: Math.max(1, Math.round(msg.durationInFrames)),
      width: typeof msg.width === "number" ? msg.width : DEFAULT_SPEC.width,
      height: typeof msg.height === "number" ? msg.height : DEFAULT_SPEC.height,
      version: typeof msg.version === "number" ? msg.version : 0,
    }
  }
  if (msg.type === "time") {
    return typeof msg.frame === "number" && Number.isFinite(msg.frame)
      ? { type: "time", frame: Math.max(0, Math.round(msg.frame)) }
      : null
  }
  if (msg.type === "error") {
    if (typeof msg.message !== "string") return null
    return { type: "error", message: msg.message, stack: typeof msg.stack === "string" ? msg.stack : undefined }
  }
  if (msg.type === "assets") {
    const fonts = Array.isArray(msg.failedFonts)
      ? msg.failedFonts.filter((f): f is string => typeof f === "string")
      : []
    return { type: "assets", failedFonts: fonts }
  }
  return null
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/**
 * Caminho da entrada DENTRO da pasta registrada — o que a URL
 * `orbit-motion://<id>/<caminho-relativo>` serve. O evento traz o relativo
 * (o normal); se vier o absoluto, não há como reconstruir a pasta da composição
 * daqui e fica o nome do arquivo.
 */
function entryPath(entry: string): string {
  const cleaned = entry.replace(/\\/g, "/").replace(/^file:\/\//, "")
  const relative = /^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith("/") ? baseName(cleaned) : cleaned.replace(/^\.\//, "")
  return relative.split("/").map(encodeURIComponent).join("/")
}

/** A camada está em cena neste quadro? */
function onScreenAt(layer: MotionLayer, frame: number): boolean {
  return layer.spans.some(([a, b]) => frame >= a && frame <= b)
}

/** Passo das marcas da régua (em segundos) para caber ~8 rótulos na largura. */
function rulerStep(seconds: number): number {
  return [1, 2, 5, 10, 15, 30, 60].find((s) => seconds / s <= 8) ?? 60
}

/**
 * Formatos que o botão Renderizar oferece, na ordem em que aparecem no menu. O
 * valor é o da união do IPC (`motion:render`) — o rótulo diz o que o arquivo é e
 * a dica, para que ele serve: a diferença entre os três é a transparência, que
 * só mov/webm carregam.
 */
const RENDER_FORMATS: { value: MotionRenderFormat; labelKey: string; hintKey: string }[] = [
  { value: "mp4", labelKey: "motion.formatMp4", hintKey: "motion.formatMp4Hint" },
  { value: "mov-alpha", labelKey: "motion.formatMovAlpha", hintKey: "motion.formatMovAlphaHint" },
  { value: "webm-alpha", labelKey: "motion.formatWebmAlpha", hintKey: "motion.formatWebmAlphaHint" },
]

export function MotionTab({
  motionId,
  entry,
  path,
  title,
}: {
  motionId?: string
  entry?: string
  /** Caminho absoluto da entrada — o endereço que a nota do chat entrega ao agente. */
  path?: string
  title: string
}) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const stageWrapRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  /** O som da peça toca FORA do iframe (o palco é sandbox: sem autoplay, sem
   *  controle): são estes elementos que o transporte comanda, um por faixa, na
   *  ordem em que o manifest as declarou. */
  const audioRefs = useRef<(HTMLAudioElement | null)[]>([])

  const [spec, setSpec] = useState<MotionSpec | null>(null)
  const [readyCount, setReadyCount] = useState(0)
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(false)
  const [measuredFps, setMeasuredFps] = useState<number | null>(null)
  const [runtimeError, setRuntimeError] = useState<{ message: string; stack?: string } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [failedFonts, setFailedFonts] = useState<string[]>([])
  const [reloads, setReloads] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [render, setRender] = useState<RenderState>({ status: "idle" })
  const [layers, setLayers] = useState<LayersState>({ status: "idle" })
  const [selectedName, setSelectedName] = useState<string | null>(null)
  /** As faixas da peça, medidas no main junto com as camadas — pela MESMA
   *  resolução que o render usa: o que a linha de tempo desenha e o que toca no
   *  preview são os arquivos que vão no vídeo, nos mesmos instantes. */
  const [audio, setAudio] = useState<{
    tracks: { name: string; url: string | null; start: number; end: number | null; offset?: number }[]
    error: string | null
  } | null>(null)
  /** O comprimento REAL de cada arquivo, medido pelo próprio elemento quando o
   *  metadata chega: é o que fecha a janela de uma faixa que o manifest não
   *  delimitou (ver `motionTrackEnd`), em vez de esticá-la até o fim da peça. */
  const [audioDurations, setAudioDurations] = useState<Record<string, number>>({})
  const audioTracks = audio?.tracks ?? []
  // O que está em foco pode ser uma CAMADA do DOM ou uma faixa de SOM. O som não
  // é elemento (toca fora do palco — ver motion-audio.ts), mas se seleciona do
  // mesmo jeito; é por aqui que a aba sabe qual dos dois está selecionado.
  const selectedAudio = audioTracks.find((track) => track.name === selectedName) ?? null
  const measureAudio = (url: string | null, el: HTMLAudioElement | null) => {
    const duration = el?.duration
    if (!url || duration === undefined || !Number.isFinite(duration) || duration <= 0) return
    setAudioDurations((prev) => (prev[url] === duration ? prev : { ...prev, [url]: duration }))
  }
  /** A medida do arquivo da faixa. A chave é a URL (e não a posição na lista):
   *  assim uma peça nova não herda por um instante a medida da anterior. Estável
   *  entre renders — ela entra nas dependências do efeito que comanda o som. */
  const trackDuration = useCallback(
    (track: { url: string | null; offset?: number }): number | null => {
      const duration = track.url ? (audioDurations[track.url] ?? null) : null
      // O arquivo toca a partir do `offset` (corte inicial de um vídeo): o que
      // sobra para a janela da faixa é o resto dele, não o comprimento inteiro.
      return duration === null ? null : Math.max(0, duration - (track.offset ?? 0))
    },
    [audioDurations],
  )
  /** `?r=` é o que faz a voz regerada entrar em cena: a URL muda a cada recarga,
   *  e sem trocá-la os elementos seguiriam tocando os bytes antigos. É também por
   *  isso que a mídia pode ser servida sem `no-store` (ver o handler do scheme). */
  const audioSrc = (url: string | null): string | null => (url ? `${url}?r=${reloads}` : null)

  /**
   * As faixas acompanham o TRANSPORTE: o iframe é o relógio (é ele que manda
   * `time` a cada quadro), os elementos de áudio são seguidores. Concentrar isso
   * num efeito — em vez de espalhar play/pause por play, pausa, arrasto da régua,
   * passo de quadro, loop e recarga — é o que garante que nenhum caminho novo
   * esqueça o som, que é exatamente como este erro nasce.
   *
   * Cada faixa tem a JANELA dela (`start`/`end`): fora dela o elemento fica
   * parado, e o instante do transporte é traduzido para a linha de tempo do
   * próprio arquivo (`at - start`). A folga de reata também cobre a volta do
   * loop, quando o playhead salta para o zero.
   */
  useEffect(() => {
    const at = frame / FPS
    const SEEK_EPSILON_S = 0.02
    const tracks = audio?.tracks ?? []
    tracks.forEach((track, index) => {
      const el = audioRefs.current[index]
      if (!el || !track.url) return
      // Posição no ARQUIVO: o tempo desde a entrada da faixa, mais o corte inicial.
      const local = at - track.start + (track.offset ?? 0)
      // A janela sai da MESMA função que desenha a barra: sem `end` no manifest
      // ela é fechada pelo comprimento real do arquivo, e não pelo fim da peça.
      const within = motionTrackIsLive(track, trackDuration(track), at)
      if (!within) {
        if (!el.paused) el.pause()
        if (el.playbackRate !== 1) el.playbackRate = 1
        return
      }
      if (!playing) {
        // Parado, o som senta no quadro do playhead — e no ritmo natural, para o
        // play seguinte sair do lugar certo e no tempo certo.
        if (el.playbackRate !== 1) el.playbackRate = 1
        if (Math.abs(el.currentTime - local) > SEEK_EPSILON_S) el.currentTime = local
        if (!el.paused) el.pause()
        return
      }
      // Rodando, o reata se divide em dois: reposicionamento DE VERDADE (arrasto
      // da régua, corte, entrada na faixa) é seek; deriva é ritmo.
      //
      // Era só seek, e isso passou a doer quando o scheme começou a anunciar
      // faixas: antes o Chromium IGNORAVA o `currentTime` (o som tocava com uma
      // folga fixa e ninguém notava); agora que ele obedece, cada deriva virava
      // descarte de buffer e rebaixamento do arquivo — o som picotava e nunca
      // assentava. Seek volta a ser só o que é reposicionamento.
      const drift = el.currentTime - local
      if (Math.abs(drift) > MOTION_AUDIO_SEEK_S) {
        el.currentTime = local
        if (el.playbackRate !== 1) el.playbackRate = 1
      } else {
        // O estado do PRÓPRIO elemento é a histerese: ele já está corrigindo?
        // Sem isso, com a deriva oscilando no limiar, o ritmo ficava ligando e
        // desligando — e cada reinício do resample é um estalo.
        const engaged = Math.abs(el.playbackRate - 1) > 0.001
        const rate = motionAudioRate(drift, engaged)
        // Folga de 0,5%: reajustar o ritmo a cada quadro seria trocar um
        // artefato por outro.
        if (Math.abs(el.playbackRate - rate) > 0.005) el.playbackRate = rate
      }
      if (el.paused) void el.play().catch(() => {})
    })
  }, [audio, playing, frame, reloads, trackDuration])
  const addQuote = usePanelStore((s) => s.addQuote)
  const quotes = usePanelStore((s) => s.quotes)
  /**
   * A camada que está presa na próxima mensagem do chat (o "marcar"). O botão da
   * linha fica aceso enquanto for ela — sem isso o gesto não teria resposta
   * visível, e a única prova estaria lá no anexo do compositor.
   */
  const quoteLayer = useMemo(() => {
    const quote = quotes.find((item) => item.kind === "motion")
    return quote?.kind === "motion" ? (quote.layer ?? null) : null
  }, [quotes])

  /** O outro lado do "marcar": a faixa de SOM presa na próxima mensagem. */
  const quoteAudio = useMemo(() => {
    const quote = quotes.find((item) => item.kind === "motion")
    return quote?.kind === "motion" ? (quote.audio ?? null) : null
  }, [quotes])

  // Espelhos para os handlers que não podem depender do render (o listener de
  // mensagem e os atalhos ficam registrados uma vez só).
  const frameRef = useRef(0)
  const playingRef = useRef(false)
  const loopRef = useRef(false)
  const specRef = useRef<MotionSpec>(DEFAULT_SPEC)
  /** Quadro a retomar depois de um remount (recarregar volta ao MESMO instante). */
  const restoreRef = useRef<number | null>(null)
  /** Instantes dos `time` recebidos: é o que mede o fps REAL do preview. */
  const tickTimes = useRef<number[]>([])
  const lastFpsAt = useRef(0)
  /** Chegou "ready" desde a última (re)carga? É o que o diagnóstico de carga consulta. */
  const loadedRef = useRef(false)

  const layout = spec ?? DEFAULT_SPEC
  const total = spec?.durationInFrames ?? 0
  const isMac = windowApi.platform === "darwin"

  const src = useMemo(
    () => (motionId && entry ? `${MOTION_SCHEME}://${motionId}/${entryPath(entry)}?r=${reloads}` : ""),
    [motionId, entry, reloads],
  )

  /** Comando painel → iframe. Sem janela montada, não há para quem mandar. */
  const post = useCallback((message: Record<string, unknown>) => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    win.postMessage({ source: MOTION_SOURCE, ...message }, "*")
  }, [])

  /** Vai para um quadro (inteiro, dentro da composição) e avisa o iframe. */
  const seek = useCallback(
    (target: number) => {
      const next = total > 0 ? Math.max(0, Math.min(Math.round(target), total - 1)) : Math.max(0, Math.round(target))
      frameRef.current = next
      setFrame(next)
      post({ type: "seek", frame: next })
    },
    [post, total],
  )

  const stopClock = useCallback(() => {
    playingRef.current = false
    setPlaying(false)
    tickTimes.current = []
    lastFpsAt.current = 0
    setMeasuredFps(null)
  }, [])

  const pause = useCallback(() => {
    post({ type: "pause" })
    stopClock()
  }, [post, stopClock])

  const togglePlay = useCallback(() => {
    if (playingRef.current) {
      pause()
      return
    }
    // Parado no último quadro, o play do runtime terminaria no mesmo instante:
    // recomeça do zero, como qualquer player.
    if (total > 0 && frameRef.current >= total - 1) seek(0)
    playingRef.current = true
    setPlaying(true)
    post({ type: "play" })
  }, [pause, post, seek, total])

  /** Passo de quadro: o play do runtime sobrescreveria o seek, então pausa antes. */
  const stepFrame = useCallback(
    (delta: number) => {
      if (playingRef.current) pause()
      seek(frameRef.current + delta)
    },
    [pause, seek],
  )

  const toggleLoop = useCallback(() => {
    const next = !loopRef.current
    loopRef.current = next
    setLoop(next)
    post({ type: "loop", on: next })
  }, [post])

  const layerList = useMemo(
    () => (layers.status === "ready" ? layers.layers : layers.status === "loading" ? layers.previous : []),
    [layers],
  )

  /**
   * Comentar o instante: prende o quadro de AGORA à próxima mensagem do chat,
   * com o que está em foco — a camada do DOM ou a faixa de som — e as camadas em
   * cena. O agente sabe de qual momento E de qual elemento a frase fala ("aqui o
   * título entra rápido").
   *
   * O quadro é congelado no clique — o anexo é um gesto de apontar, não um
   * playhead que segue tocando. Clicar de novo substitui o instante anterior em
   * vez de acumular (ver addQuote no panel-store).
   */
  const comment = useCallback(
    (target?: { layer?: string; audio?: string }) => {
      if (!entry) return
      const at = frameRef.current
      const onScreen = layerList.filter((l) => onScreenAt(l, at)).map((l) => l.name)
      // O alvo vem do botão da LINHA quando foi ele que chamou; sem ele vale o que
      // está em foco. Camada e som são campos DIFERENTES: dizer "camada" de um som
      // mandaria o agente procurar no palco um elemento que não existe lá.
      const layer = target ? target.layer : selectedAudio ? undefined : (selectedName ?? undefined)
      const audio = target ? target.audio : (selectedAudio?.name ?? undefined)
      addQuote({
        kind: "motion",
        file: entry,
        name: title,
        frame: at,
        fps: FPS,
        ...(path ? { path } : {}),
        ...(layer ? { layer } : {}),
        ...(audio ? { audio } : {}),
        ...(onScreen.length ? { onScreen: onScreen.slice(0, 12) } : {}),
      })
    },
    [addQuote, entry, title, path, selectedName, selectedAudio, layerList],
  )

  // ------------------------------------------------------------ ponte iframe
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = iframeRef.current?.contentWindow
      // A origem do iframe é opaca (sandbox sem allow-same-origin): quem diz que
      // a mensagem é DESTE iframe é a janela de origem, não a origem.
      if (!win || event.source !== win) return
      const msg = parseRuntimeMessage(event.data)
      if (!msg) return
      if (msg.type === "ready") {
        const next: MotionSpec = {
          width: msg.width,
          height: msg.height,
          durationInFrames: msg.durationInFrames,
        }
        specRef.current = next
        loadedRef.current = true
        setSpec(next)
        setReadyCount((n) => n + 1)
        // Página nova: os avisos da anterior não valem mais.
        setRuntimeError(null)
        setLoadError(null)
        setFailedFonts([])
        // O loop vive no runtime e se perde no remount: reafirma o estado.
        post({ type: "loop", on: loopRef.current })
        const restore = restoreRef.current
        restoreRef.current = null
        // A composição pode ter ficado mais curta entre as duas versões: o
        // quadro a retomar é preso ao comprimento NOVO.
        if (restore != null) seek(Math.min(restore, msg.durationInFrames - 1))
        return
      }
      if (msg.type === "time") {
        frameRef.current = msg.frame
        setFrame(msg.frame)
        const now = performance.now()
        const times = tickTimes.current
        times.push(now)
        while (times.length > 0 && now - times[0] > 1000) times.shift()
        if (times.length >= 2 && now - lastFpsAt.current > 400) {
          lastFpsAt.current = now
          setMeasuredFps(Math.round(((times.length - 1) * 1000) / (now - times[0])))
        }
        if (msg.frame >= specRef.current.durationInFrames - 1) {
          // Repetir: o play do runtime PARA no último quadro mesmo com loop
          // ligado (o `frame >= total - 1` dele vence o caso do loop), então
          // quem reinicia é o painel — volta ao zero e manda tocar de novo.
          if (loopRef.current) {
            seek(0)
            post({ type: "play" })
          } else {
            // Sem loop o runtime parou de verdade: o transporte precisa saber,
            // senão ficaria "tocando" para sempre.
            stopClock()
          }
        }
        return
      }
      if (msg.type === "error") {
        setRuntimeError({ message: msg.message, stack: msg.stack })
        return
      }
      setFailedFonts(msg.failedFonts)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [post, seek, stopClock])

  // ------------------------------------------------------------- recarregar
  const reload = useCallback(() => {
    restoreRef.current = frameRef.current
    // A página nova nasce parada: o transporte não pode continuar dizendo
    // "tocando" enquanto ninguém manda quadro nenhum.
    stopClock()
    setRuntimeError(null)
    setLoadError(null)
    setFailedFonts([])
    setReloads((n) => n + 1)
  }, [stopClock])

  // O agente reescreveu o arquivo (fs.watch do main): recarrega voltando ao
  // mesmo quadro, que é o que deixa comparar o antes e o depois do ajuste.
  useEffect(() => {
    if (!motionId) return
    return motionApi.onChanged((payload) => {
      if (payload.id === motionId) reload()
    })
  }, [motionId, reload])

  // Sem "ready" a tempo, a página não vai responder: pergunta ao scheme o que
  // houve (a mesma URL, por fetch — o scheme aceita CORS) e mostra o motivo,
  // em vez de deixar o palco girando para sempre.
  useEffect(() => {
    if (!src) return
    loadedRef.current = false
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (loadedRef.current) return
      void fetch(src)
        .then(async (res) => {
          if (cancelled) return
          if (!res.ok) {
            const text = (await res.text().catch(() => "")).trim().slice(0, 120)
            setLoadError(t("motion.loadFailedHttp", { status: res.status, text: text || res.statusText }))
          } else {
            setLoadError(t("motion.loadTimeout", { seconds: LOAD_TIMEOUT_MS / 1000 }))
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
        })
    }, LOAD_TIMEOUT_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [src, t])

  // ------------------------------------------------------------ camadas
  // A cada página nova (carga, recarga ao vivo) as camadas são medidas de novo:
  // o agente acabou de mudar quando algo entra ou sai. As faixas antigas ficam
  // na tela enquanto a medição nova roda — sem piscar a cada save.
  useEffect(() => {
    if (!motionId || readyCount === 0) return
    let cancelled = false
    setLayers((prev) => ({
      status: "loading",
      previous: prev.status === "ready" ? prev.layers : prev.status === "loading" ? prev.previous : [],
    }))
    const timer = window.setTimeout(() => {
      motionApi
        .layers(motionId)
        .then((result) => {
          if (cancelled) return
          setLayers({ status: "ready", layers: result.layers })
          // A trilha vem na mesma medição. Só é trocada quando a composição
          // RESPONDEU: durante o "medindo" o áudio da versão anterior continua na
          // tela, como as faixas das camadas.
          setAudio(result.audio)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err)
          setLayers({ status: "error", message })
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [motionId, readyCount])

  // A camada selecionada sumiu da composição (o agente a removeu ou renomeou).
  useEffect(() => {
    // Uma faixa de som também tem nome e NÃO é camada: sem a ressalva, o som
    // selecionado seria desmarcado no mesmo instante em que fosse clicado.
    if (
      selectedName &&
      !selectedAudio &&
      layers.status === "ready" &&
      !layers.layers.some((l) => l.name === selectedName)
    ) {
      setSelectedName(null)
    }
  }, [layers, selectedName, selectedAudio])

  /**
   * O realce de quem está selecionado mora no PREVIEW, não aqui: o palco é um
   * sandbox sem same-origin, então quem contorna o elemento é o runtime, a nosso
   * pedido. E o endereço é o ÍNDICE na caminhada da página, não o rótulo — dois
   * elementos podem se chamar ".caption".
   *
   * Reenvia quando a lista de camadas muda: um save remonta o iframe, e o
   * documento novo não sabe de realce nenhum. `index: -1` é "tire o realce".
   */
  useEffect(() => {
    const layer = layers.status === "ready" ? layers.layers.find((l) => l.name === selectedName) : undefined
    post(layer ? { type: "highlight", index: layer.index, name: layer.name } : { type: "highlight", index: -1, name: null })
  }, [selectedName, layers, post])

  // ----------------------------------------------------------- atalhos
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // Digitar no chat (ou em qualquer campo) não pode mexer no playhead.
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return
      // A aba precisa estar visível: com outra aba em cima, as setas são de outro.
      if (!rootRef.current || rootRef.current.offsetParent === null) return
      if (e.key === " ") {
        e.preventDefault()
        togglePlay()
      } else if (e.key === "ArrowLeft") {
        e.preventDefault()
        stepFrame(-1)
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        stepFrame(1)
      } else if (e.key === "Escape" && fullscreen) {
        setFullscreen(false)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [togglePlay, stepFrame, fullscreen])

  // -------------------------------------------------------------- palco
  // O palco fica no TOPO, na proporção nativa da composição: ocupa a largura do
  // painel e, numa peça vertical ou num painel baixo, para numa fração da
  // altura — o resto é da linha de tempo, e não sobra faixa preta em volta.
  useEffect(() => {
    const wrap = stageWrapRef.current
    const root = rootRef.current
    if (!wrap || !root) return
    const update = () => {
      const width = wrap.clientWidth
      const height = root.clientHeight
      if (width <= 0 || height <= 0) return
      const maxHeight = Math.max(140, height * (fullscreen ? STAGE_MAX_RATIO_FULLSCREEN : STAGE_MAX_RATIO))
      const scale = Math.min(width / layout.width, maxHeight / layout.height)
      setBox({
        width: Math.max(1, Math.floor(layout.width * scale)),
        height: Math.max(1, Math.floor(layout.height * scale)),
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(wrap)
    observer.observe(root)
    return () => observer.disconnect()
  }, [layout.width, layout.height, fullscreen])

  // ------------------------------------------------------------- régua
  const dragging = useRef(false)

  const frameAt = useCallback((clientX: number) => {
    const el = trackRef.current
    const count = specRef.current.durationInFrames
    if (!el || count <= 0) return 0
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return Math.round(ratio * (count - 1))
  }, [])

  const onTrackDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (specRef.current.durationInFrames <= 0) return
      e.preventDefault()
      // Arrastar é inspecionar: pausa antes, senão o play do runtime
      // sobrescreveria o seek no quadro seguinte.
      if (playingRef.current) pause()
      dragging.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      seek(frameAt(e.clientX))
    },
    [frameAt, pause, seek],
  )

  const onTrackMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      seek(frameAt(e.clientX))
    },
    [frameAt, seek],
  )

  const onTrackUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }, [])

  // ------------------------------------------------------------- render
  useEffect(() => {
    if (!motionId) return
    return motionApi.onProgress((payload) => {
      if (payload.id !== motionId) return
      setRender((prev) =>
        prev.status === "running" ? { status: "running", frame: payload.frame, total: payload.total } : prev,
      )
    })
  }, [motionId])

  // O estado do render vira três valores simples: o handler não depende do
  // objeto inteiro e o JSX não precisa estreitar a união em cada uso.
  const rendering = render.status === "running"
  const renderTotal = render.status === "running" ? render.total : 0
  const renderedPath = render.status === "done" ? render.path : null
  const renderError = render.status === "error" ? render.message : null
  const renderPercent = rendering && renderTotal > 0 ? Math.round((render.frame / renderTotal) * 100) : 0

  /** O formato é a última decisão antes do arquivo existir: vem do clique. */
  const onRender = useCallback(
    (format: MotionRenderFormat) => {
      if (!motionId || rendering) return
      setRender({ status: "running", frame: 0, total: 0 })
      motionApi
        .render(motionId, format)
        .then((result) => {
          // O render começa por um diálogo de salvar do sistema: cancelar não é
          // falha, é a pessoa desistindo — a aba volta ao repouso.
          if ("canceled" in result) {
            setRender({ status: "idle" })
            return
          }
          setRender({ status: "done", path: result.path })
        })
        .catch((err: unknown) =>
          setRender({ status: "error", message: err instanceof Error ? err.message : String(err) }),
        )
    },
    [motionId, rendering],
  )

  const reveal = useCallback((target: string) => {
    // Mesmo canal dos outros pontos do app (file-viewer, video-part, task-modal):
    // abrir a pasta do sistema com o arquivo já selecionado.
    void window.ipcRenderer.invoke("shell:showItemInFolder", target)
  }, [])

  if (!motionId) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {t("motion.unavailable")}
      </div>
    )
  }

  const pct = (f: number) => (total > 1 ? (f / (total - 1)) * 100 : 0)
  const position = pct(frame)
  const seconds = total / FPS
  const step = rulerStep(seconds)
  const marks = total > 0 ? Array.from({ length: Math.floor(seconds / step) + 1 }, (_, i) => i * step) : []
  // A coluna do nome cresceu para caber o ÍCONE do tipo e o botão de marcar sem
  // espremer o nome. É UMA largura, usada pela régua, pelas faixas de áudio e
  // pelas camadas: é ela que mantém as três na mesma escala (playhead incluído).
  const nameColumn = fullscreen ? "w-44" : "w-32"
  const failed = loadError

  return (
    // Em tela cheia o MESMO nó vira o overlay fixo (como o browser do painel):
    // o iframe não é remontado, então o playhead e a ponte sobrevivem.
    <div
      ref={rootRef}
      className={cn(
        // `bg-sidebar`, o mesmo das outras abas do painel (o terminal e o browser
        // usam esse): com `bg-background` a aba destoava do resto e o cabeçalho
        // parecia colado na faixa de abas.
        "group/motion flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar",
        fullscreen && cn("fixed inset-0 z-[70] h-auto w-auto rounded-none border-0", isMac && "top-8"),
      )}
    >
      {/* Cabeçalho: composição + arquivo à esquerda; recarregar, tela cheia e
          render à direita. Mesmo respiro do cabeçalho do browser (p-2). */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 p-2">
        <div className="flex min-w-0 items-center gap-2">
          <Clapperboard className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium text-muted-foreground">{title}</span>
          {entry && (
            <Badge variant="outline" className="max-w-44 shrink-0 truncate font-mono" title={path ?? entry}>
              {baseName(entry)}
            </Badge>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconAction icon={RotateCw} label={t("motion.reload")} onClick={reload} />
          <IconAction
            icon={fullscreen ? Minimize2 : Maximize2}
            label={t(fullscreen ? "motion.exitFullscreen" : "motion.fullscreen")}
            onClick={() => setFullscreen((v) => !v)}
          />
          {/* Renderizar: o formato é escolha do clique (menu), não um passo à
              parte. Enquanto renderiza o trigger fica desabilitado e vira o
              próprio indicador de progresso. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={rendering || total <= 0}
              render={<Button variant="default" size="lg" className="ml-1 gap-1.5" />}
            >
              {rendering ? <Loader2 className="size-3.5 animate-spin" /> : <Film className="size-3.5" />}
              {rendering && renderTotal > 0
                ? t("motion.rendering", { percent: renderPercent })
                : t("motion.render")}
              {!rendering && <ChevronDown className="size-3 opacity-70" />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("motion.renderFormat")}</DropdownMenuLabel>
                {RENDER_FORMATS.map((format) => (
                  <DropdownMenuItem key={format.value} onClick={() => onRender(format.value)}>
                    <span className="flex-1">{t(format.labelKey)}</span>
                    <span className="shrink-0 text-[0.625rem] text-muted-foreground">{t(format.hintKey)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Linha fina do progresso do render — o estado do botão diz o número. */}
      {rendering && (
        <div className="h-0.5 shrink-0 bg-muted">
          <div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${renderPercent}%` }} />
        </div>
      )}

      {/* Feedback do render: o MESMO respiro lateral do palco (px-3). O `Alert`
          nasce com `w-full` — com margem lateral ele media 100% + 2×margem e
          estourava o painel exatamente por essa margem; o `overflow-hidden` do
          painel então cortava a borda direita e o X. Quem dá o respiro é o
          container, não o card. */}
      {renderedPath && (
        <div className="shrink-0 px-3 pt-2">
          <Alert>
            <CircleCheck className="text-emerald-500" />
            <AlertTitle>{t("motion.rendered", { file: baseName(renderedPath) })}</AlertTitle>
            <AlertDescription className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => reveal(renderedPath)} title={renderedPath}>
                {t("motion.showInFolder")}
              </Button>
            </AlertDescription>
            <AlertAction>
              <IconAction icon={X} label={t("motion.dismiss")} onClick={() => setRender({ status: "idle" })} />
            </AlertAction>
          </Alert>
        </div>
      )}

      {renderError && (
        <div className="shrink-0 px-3 pt-2">
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{t("motion.renderFailed")}</AlertTitle>
            <AlertDescription className="break-words">{renderError}</AlertDescription>
            <AlertAction>
              <IconAction icon={X} label={t("motion.dismiss")} onClick={() => setRender({ status: "idle" })} />
            </AlertAction>
          </Alert>
        </div>
      )}

      {failedFonts.length > 0 && (
        <div className="shrink-0 px-3 pt-2">
          <Alert>
            <AlertTriangle className="text-amber-500" />
            <AlertTitle>{t("motion.fontsFailed")}</AlertTitle>
            <AlertDescription className="break-words">{failedFonts.join(", ")}</AlertDescription>
          </Alert>
        </div>
      )}

      {/* Palco no topo: a composição na proporção nativa, sem faixa preta em
          volta — o que sobra da altura é da linha de tempo. */}
      <div ref={stageWrapRef} className="flex shrink-0 justify-center px-3 pt-3">
        {/* O palco é só a JANELA: quem carrega o tamanho da peça é o iframe.
            `maxWidth` segura o iframe ainda sem escala (o documento tem o tamanho
            declarado) de estourar o painel no primeiro quadro. */}
        <div
          className="relative overflow-hidden rounded-md bg-black ring-1 ring-border/60"
          style={{ width: box.width || undefined, height: box.height || 160, maxWidth: "100%" }}
        >
          <iframe
            ref={iframeRef}
            // Remonta o iframe (recarga de verdade): a URL da composição não muda
            // quando o arquivo é reescrito no lugar.
            key={`${motionId}:${reloads}`}
            src={src}
            title={title}
            // SEM allow-same-origin de propósito: `allow-scripts` + same-origin
            // deixaria a composição remover o próprio sandbox.
            sandbox="allow-scripts"
            allow=""
            referrerPolicy="no-referrer"
            // A composição é um documento do TAMANHO DECLARADO (o guia manda
            // html/body em 1920x1080), não uma página que se adapta ao palco. O
            // iframe recebe o tamanho REAL — é ele que define a viewport interna
            // que a composição lê, a mesma da janela de captura do render — e só
            // o `scale` o encolhe para caber no palco. Com `h-full w-full` o
            // documento transbordava e o palco mostrava o canto superior esquerdo.
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${box.width > 0 ? box.width / layout.width : 1})`,
              transformOrigin: "top left",
            }}
            className={cn("border-0 bg-transparent", !spec && "invisible")}
          />
          {!spec && !runtimeError && !failed && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-muted/30 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("motion.loading")}
            </div>
          )}
          {/* Não carregou: o motivo no lugar da tela girando, e a saída. */}
          {failed && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted/40 p-3 text-center">
              <AlertTriangle className="size-4 text-destructive" />
              <span className="text-xs font-medium">{t("motion.loadFailed")}</span>
              <span className="max-w-full break-words text-[11px] text-muted-foreground">{failed}</span>
              <Button variant="outline" size="sm" onClick={reload}>
                {t("motion.retry")}
              </Button>
            </div>
          )}
          {/* Composição quebrada: o aviso no lugar da tela preta vazia (o iframe
              segue vivo atrás — recarregar é a saída). */}
          {runtimeError && (
            <div className="absolute inset-0 flex items-start justify-center overflow-auto bg-black/85 p-3">
              <Alert variant="destructive" className="max-w-lg">
                <AlertTriangle />
                <AlertTitle>{t("motion.error")}</AlertTitle>
                <AlertDescription className="break-words">{runtimeError.message}</AlertDescription>
                {runtimeError.stack && (
                  <pre className="col-span-2 mt-1 max-h-40 overflow-auto text-[10px] whitespace-pre-wrap text-muted-foreground">
                    {runtimeError.stack}
                  </pre>
                )}
              </Alert>
            </div>
          )}
        </div>
      </div>

      {/* Metadados: onde o playhead está, no vocabulário do usuário e no da
          composição; o fps medido aparece só tocando. */}
      <div className="flex shrink-0 items-center gap-x-3 px-3 pt-2 text-[10px] tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground">{motionTimecode(frame, FPS)}</span>
        <span>{motionSeconds(frame, FPS)}</span>
        <span>
          {layout.width}×{layout.height}
        </span>
        <span>{FPS} fps</span>
        <span className="ml-auto" title={t("motion.measuredFpsHint")}>
          {playing && measuredFps != null ? t("motion.measuredFps", { fps: measuredFps }) : ""}
        </span>
      </div>

      {/* Transporte: repetir à esquerda, quadro a quadro no meio e comentar o
          instante à direita — os dois extremos são ações sobre o que se vê. */}
      <div className="flex shrink-0 items-center justify-between gap-2 px-2.5 py-1">
        <Button
          variant={loop ? "secondary" : "ghost"}
          size="icon-sm"
          aria-pressed={loop}
          title={t("motion.loop")}
          aria-label={t("motion.loop")}
          onClick={toggleLoop}
        >
          <Repeat className="size-3.5" />
        </Button>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            disabled={total <= 0}
            title={t("motion.prevFrame")}
            aria-label={t("motion.prevFrame")}
            onClick={() => stepFrame(-1)}
          >
            <SkipBack className="size-3.5" />
          </Button>
          <Button
            variant={playing ? "secondary" : "default"}
            size="icon"
            disabled={total <= 0}
            title={t(playing ? "motion.pause" : "motion.play")}
            aria-label={t(playing ? "motion.pause" : "motion.play")}
            onClick={togglePlay}
          >
            {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={total <= 0}
            title={t("motion.nextFrame")}
            aria-label={t("motion.nextFrame")}
            onClick={() => stepFrame(1)}
          >
            <SkipForward className="size-3.5" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!entry || total <= 0}
          title={t("motion.commentHint")}
          aria-label={t("motion.commentHint")}
          onClick={() => comment()}
        >
          <MessageSquarePlus className="size-3.5" />
        </Button>
      </div>

      {/* Linha de tempo: régua + uma faixa por camada, com a mesma escala e o
          mesmo playhead. Clicar ou arrastar em qualquer ponto busca o quadro;
          clicar no nome seleciona a camada para a nota do chat. */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-border/60">
        {/* A régua vive DENTRO da área rolável, grudada no topo. Fora dela, a
            largura da régua não batia com a das linhas assim que a barra de
            rolagem aparecia (ela ocupa 6px — ver `*::-webkit-scrollbar`), e o
            playhead saía do lugar em relação às camadas. Aqui régua e linhas têm
            a mesma largura por construção; o fundo opaco é o que deixa as linhas
            passarem por baixo. */}
        <div className="relative min-h-0 flex-1 overflow-y-auto pb-2">
          <div className="sticky top-0 z-10 flex items-center bg-sidebar">
            <div className={cn("flex shrink-0 items-center gap-1.5 px-3 text-[10px] font-medium text-muted-foreground", nameColumn)}>
            <Layers className="size-3" />
            {t("motion.layers")}
          </div>
          <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-label={t("motion.timeline")}
            aria-valuemin={0}
            aria-valuemax={Math.max(0, total - 1)}
            aria-valuenow={frame}
            onPointerDown={onTrackDown}
            onPointerMove={onTrackMove}
            onPointerUp={onTrackUp}
            onPointerCancel={onTrackUp}
            className={cn(
              "relative mr-3 h-6 flex-1 touch-none select-none",
              total > 0 ? "cursor-pointer" : "opacity-50",
            )}
          >
            {marks.map((s) => (
              <div key={s} className="absolute inset-y-0" style={{ left: `${pct(s * FPS)}%` }}>
                <div className="absolute bottom-0 h-1.5 w-px bg-border" />
                <span className="absolute top-0.5 left-1 text-[9px] tabular-nums text-muted-foreground">{s}s</span>
              </div>
            ))}
            <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-primary" style={{ left: `${position}%` }} />
          </div>
        </div>
          {/* O som da peça toca FORA do iframe (o palco é sandbox: sem autoplay,
              sem controle próprio), então os elementos vivem aqui — invisíveis —
              e quem os comanda é o transporte, pelo efeito acima. Um por faixa, na
              ordem do manifest: é o índice que casa o elemento com a faixa. */}
          {audioTracks.map((track, index) => (
            <audio
              key={`audio-${track.name}-${index}`}
              ref={(el) => {
                audioRefs.current[index] = el
              }}
              src={audioSrc(track.url) ?? undefined}
              preload="auto"
              onLoadedMetadata={(e) => measureAudio(track.url, e.currentTarget)}
            />
          ))}
          {/* Cada faixa é uma LINHA, desenhada onde ela toca: a régua é a peça
              inteira, então `start`/`end` viram posição e comprimento — dá para ver
              a cama de música, o efeito pontual e a narração de uma vez. Sem `url`
              o áudio está FORA da pasta da composição: vai no arquivo renderizado,
              mas o scheme não o serve e o preview fica mudo. */}
          {audioTracks.map((track, index) => {
            const seconds = total / FPS
            const at = frame / FPS
            const from = seconds > 0 ? Math.min(100, Math.max(0, (track.start / seconds) * 100)) : 0
            // Sem `end` no manifest a barra esticava até a borda direita; agora ela
            // termina onde o arquivo realmente tem som (ver motionTrackEnd).
            const end = motionTrackEnd(track, trackDuration(track)) ?? seconds
            const to = seconds > 0 ? Math.min(100, Math.max(from, (end / seconds) * 100)) : 100
            const live = playing && track.url !== null && motionTrackIsLive(track, trackDuration(track), at)
            const selected = selectedName === track.name
            const markedAudio = quoteAudio === track.name
            return (
              <div
                key={`track-${track.name}-${index}`}
                className={cn("group/audio flex h-6 items-center", selected && "bg-primary/10")}
                title={t(track.url ? "motion.audioHint" : "motion.audioOutside")}
              >
                <div
                  className={cn(
                    "flex h-full min-w-0 shrink-0 items-center gap-1.5 truncate px-3 text-[11px] transition-colors",
                    nameColumn,
                    selected
                      ? "font-medium text-foreground"
                      : live
                        ? "text-foreground/90"
                        : "text-muted-foreground",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedName(selected ? null : track.name)}
                    title={t("motion.audioSelect", { name: track.name })}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <span
                      className={cn("size-1.5 shrink-0 rounded-full", live ? "bg-emerald-500" : "bg-muted-foreground/30")}
                    />
                    {/* O ícone de SOM também nesta linha: a faixa não é elemento
                        do DOM (toca fora do palco), mas é do mesmo tipo que uma
                        camada de áudio de composição — o desenho diz isso sem
                        precisar de palavra. */}
                    <Music className="size-3 shrink-0 opacity-70" />
                    <span className="truncate italic">{track.name}</span>
                  </button>
                  {/* Marcar a FAIXA, como se marca a camada — mas em `audio`: o
                      agente precisa saber que é som, senão procura no palco um
                      elemento com o nome da trilha. */}
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedName(track.name)
                      comment({ audio: track.name })
                    }}
                    title={t("motion.audioMarkHint", { name: track.name })}
                    aria-label={t("motion.audioMarkHint", { name: track.name })}
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded transition-opacity",
                      markedAudio
                        ? "text-primary opacity-100"
                        : "text-muted-foreground opacity-0 group-hover/audio:opacity-100",
                    )}
                  >
                    <MessageSquarePlus className="size-3" />
                  </button>
                </div>
                <div className="relative mr-3 h-full flex-1">
                  <div
                    className={cn(
                      "absolute inset-y-1 rounded-sm",
                      track.url ? "bg-primary/20" : "bg-muted-foreground/20",
                    )}
                    style={{ left: `${from}%`, width: `${Math.max(0.5, to - from)}%` }}
                  />
                  <div
                    className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-primary/70"
                    style={{ left: `${position}%` }}
                  />
                </div>
              </div>
            )
          })}
          {audio?.error && (
            <p className="px-3 py-2 text-[11px] text-amber-500">{t("motion.audioFailed", { error: audio.error })}</p>
          )}
          {layers.status === "loading" && layers.previous.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {t("motion.layersLoading")}
            </div>
          )}
          {layers.status === "error" && spec && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">{t("motion.layersFailed", { error: layers.message })}</p>
          )}
          {layers.status === "ready" && layers.layers.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">{t("motion.layersEmpty")}</p>
          )}
          {layerList.map((layer, index) => {
            const selected = selectedName === layer.name
            const visible = onScreenAt(layer, frame)
            const marked = quoteLayer === layer.name
            const first = layer.spans[0]
            const last = layer.spans[layer.spans.length - 1]
            const KindIcon = LAYER_ICON[layer.kind] ?? Box
            const mark = () => {
              setSelectedName(layer.name)
              comment({ layer: layer.name })
            }
            return (
              <div
                key={`${layer.name}-${index}`}
                className={cn("group/layer flex h-6 items-center", selected && "bg-primary/10")}
              >
                <div
                  className={cn(
                    "flex h-full min-w-0 shrink-0 items-center gap-1.5 truncate px-3 text-[11px] transition-colors",
                    nameColumn,
                    selected ? "font-medium text-foreground" : visible ? "text-foreground/90" : "text-muted-foreground",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedName(selected ? null : layer.name)}
                    title={t("motion.layerSelect", { name: layer.name })}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        visible ? "bg-emerald-500" : "bg-muted-foreground/30",
                      )}
                    />
                    {/* O `title` vai no invólucro: o ícone do lucide não aceita o
                        atributo, e o nome do tipo tem de estar a um hover. */}
                    <span className="flex shrink-0" title={t(`motion.kind.${layer.kind}`)}>
                      <KindIcon className="size-3 opacity-70" />
                    </span>
                    <span className={cn("truncate", !layer.named && "italic")}>{layer.name}</span>
                  </button>
                  {/* Marcar: prende ESTA camada — e o quadro de agora — à próxima
                      mensagem do chat. Aparece no hover e fica aceso quando é a
                      marcada: em quarenta faixas, botão sempre visível é ruído. */}
                  <button
                    type="button"
                    onClick={mark}
                    title={t("motion.layerMarkHint", { name: layer.name })}
                    aria-label={t("motion.layerMarkHint", { name: layer.name })}
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded transition-opacity",
                      marked
                        ? "text-primary opacity-100"
                        : "text-muted-foreground opacity-0 group-hover/layer:opacity-100",
                    )}
                  >
                    <MessageSquarePlus className="size-3" />
                  </button>
                </div>
                <div
                  className="relative mr-3 h-full flex-1 cursor-pointer touch-none select-none"
                  onPointerDown={onTrackDown}
                  onPointerMove={onTrackMove}
                  onPointerUp={onTrackUp}
                  onPointerCancel={onTrackUp}
                  title={
                    first && last
                      ? t("motion.layerSpan", {
                          name: layer.name,
                          from: motionTimecode(first[0], FPS),
                          to: motionTimecode(last[1], FPS),
                        })
                      : layer.name
                  }
                >
                  {layer.spans.map(([a, b]) => (
                    <div
                      key={`${a}-${b}`}
                      // Clicar na própria BARRA seleciona a camada — e o evento
                      // segue para a faixa, que reposiciona o playhead: os dois
                      // gestos pedem a mesma coisa ("ir até ali e me mostrar quem
                      // é"). Não é preciso parar a propagação; este chega antes,
                      // o da faixa logo depois.
                      onPointerDown={() => setSelectedName(layer.name)}
                      className={cn(
                        "absolute inset-y-1 rounded-sm",
                        selected ? "bg-primary" : layer.named ? "bg-primary/45" : "bg-muted-foreground/35",
                      )}
                      style={{ left: `${pct(a)}%`, width: `max(2px, ${pct(b) - pct(a)}%)` }}
                    />
                  ))}
                  <div
                    className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-primary/70"
                    style={{ left: `${position}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
