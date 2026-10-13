import { useTranslation } from "react-i18next"
import { AudioLines } from "lucide-react"
import { cn } from "@/lib/utils"

function formatDuration(ms?: number): string | null {
  if (!ms || !Number.isFinite(ms)) return null
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/**
 * Player de um áudio da conversa: o gerado pelo agente (tool audio_generate,
 * na resposta) e o anexado pelo usuário (chip na bolha). O arquivo vem do
 * orbit-audio://, que serve com Range — o <audio> busca posição e descobre a
 * duração sem baixar tudo antes.
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
  const duration = formatDuration(durationMs)
  return (
    <div className={cn("flex w-full max-w-md flex-col gap-1.5 rounded-xl border bg-muted/30 p-2.5", className)}>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <AudioLines className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={title}>
          {title}
        </span>
        {duration && <span className="shrink-0 tabular-nums">{duration}</span>}
      </div>
      <audio controls preload="metadata" src={src} className="h-9 w-full" />
    </div>
  )
}

/** Áudio gerado pelo agente, na resposta. */
export function AudioPartView({ part }: { part: { src: string; title?: string; durationMs?: number } }) {
  const { t } = useTranslation()
  return <AudioPlayerCard className="my-2" src={part.src} title={part.title || t("audio.generated")} durationMs={part.durationMs} />
}
