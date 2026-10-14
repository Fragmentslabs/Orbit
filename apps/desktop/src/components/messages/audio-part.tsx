import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { AudioLines, Download, Pause, Play } from "lucide-react"
import { mediaApi } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"

/** m:ss (h:mm:ss passando de uma hora). */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
}

/** Velocidades do botão de ritmo, em ciclo. */
const RATES = [1, 1.5, 2] as const

/** Só um áudio da conversa toca por vez: dar play num pausa o outro. */
let playingNow: HTMLAudioElement | null = null

/**
 * Player de um áudio da conversa: o gerado pelo agente (tool audio_generate,
 * na resposta) e o anexado pelo usuário (na bolha). Controles próprios, no
 * visual do app, em vez dos do <audio> nativo: play/pausa, barra de progresso
 * que aceita clique, arraste e setas, tempo, velocidade e salvar.
 *
 * O <audio> fica escondido e só toca: o arquivo vem do orbit-audio://, que
 * serve com Range, então buscar posição não baixa o arquivo inteiro.
 */
export function AudioPlayerCard({
  src,
  title,
  durationMs,
  className,
}: {
  src: string
  title: string
  durationMs?: number
  className?: string
}) {
  const { t } = useTranslation()
  const audioRef = useRef<HTMLAudioElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  // A duração do registro vale até o arquivo dizer a dele (alguns formatos,
  // como webm, nem dizem: aí fica a do registro).
  const [duration, setDuration] = useState((durationMs ?? 0) / 1000)
  const [rate, setRate] = useState<(typeof RATES)[number]>(1)
  const [dragging, setDragging] = useState(false)

  // Progresso suave enquanto toca: o `timeupdate` vem só ~4 vezes por segundo.
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = () => {
      const audio = audioRef.current
      if (audio && !dragging) setCurrent(audio.currentTime)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, dragging])

  // Saiu da tela tocando: para.
  useEffect(
    () => () => {
      const audio = audioRef.current
      if (audio && playingNow === audio) playingNow = null
      audio?.pause()
    },
    [],
  )

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!audio.paused) {
      audio.pause()
      return
    }
    if (playingNow && playingNow !== audio) playingNow.pause()
    playingNow = audio
    // Terminou e clicou de novo: recomeça do início.
    if (audio.ended) audio.currentTime = 0
    void audio.play().catch(() => setPlaying(false))
  }, [])

  const seekTo = useCallback(
    (seconds: number) => {
      const audio = audioRef.current
      if (!audio || !duration) return
      const clamped = Math.min(Math.max(seconds, 0), duration)
      audio.currentTime = clamped
      setCurrent(clamped)
    },
    [duration],
  )

  /** Posição do ponteiro na barra → segundos. */
  const timeAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return ((clientX - rect.left) / rect.width) * duration
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!duration) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    setCurrent(Math.min(Math.max(timeAt(event.clientX), 0), duration))
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setCurrent(Math.min(Math.max(timeAt(event.clientX), 0), duration))
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setDragging(false)
    seekTo(timeAt(event.clientX))
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 15 : 5
    if (event.key === "ArrowRight") seekTo(current + step)
    else if (event.key === "ArrowLeft") seekTo(current - step)
    else if (event.key === "Home") seekTo(0)
    else if (event.key === "End") seekTo(duration)
    else if (event.key === " " || event.key === "Enter") toggle()
    else return
    event.preventDefault()
  }

  const cycleRate = () => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length]
    setRate(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }

  const progress = duration > 0 ? Math.min(current / duration, 1) * 100 : 0

  return (
    <div className={cn("flex w-full max-w-md items-center gap-3 rounded-xl border bg-muted/30 p-2.5", className)}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration
          if (Number.isFinite(value) && value > 0) setDuration(value)
          event.currentTarget.playbackRate = rate
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setCurrent(duration)
          if (playingNow === audioRef.current) playingNow = null
        }}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t("audio.pause") : t("audio.play")}
        title={playing ? t("audio.pause") : t("audio.play")}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/85"
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <AudioLines className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-foreground" title={title}>
            {title}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {formatClock(current)} / {formatClock(duration)}
          </span>
        </div>
        {/* Barra própria: área de toque mais alta que a linha visível. */}
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label={t("audio.seek")}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          aria-valuetext={`${formatClock(current)} / ${formatClock(duration)}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDragging(false)}
          onKeyDown={onKeyDown}
          className="group/track relative flex h-3 cursor-pointer touch-none items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
          </div>
          <div
            className={cn(
              "pointer-events-none absolute size-3 -translate-x-1/2 rounded-full bg-primary shadow transition-opacity",
              dragging ? "opacity-100" : "opacity-0 group-hover/track:opacity-100 group-focus-visible/track:opacity-100",
            )}
            style={{ left: `${progress}%` }}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={cycleRate}
        aria-label={t("audio.speed", { rate })}
        title={t("audio.speed", { rate })}
        className="flex h-7 min-w-9 shrink-0 items-center justify-center rounded-md px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {rate}×
      </button>
      <button
        type="button"
        onClick={() => void mediaApi.exportAudio(src, title)}
        aria-label={t("audio.download")}
        title={t("audio.download")}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Download className="size-3.5" />
      </button>
    </div>
  )
}

/** Áudio gerado pelo agente, na resposta. */
export function AudioPartView({ part }: { part: { src: string; title?: string; durationMs?: number } }) {
  const { t } = useTranslation()
  return <AudioPlayerCard className="my-2" src={part.src} title={part.title || t("audio.generated")} durationMs={part.durationMs} />
}
