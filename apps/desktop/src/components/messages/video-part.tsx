import { useTranslation } from "react-i18next"
import { Clapperboard, FolderOpen } from "lucide-react"

function formatDuration(ms?: number): string | null {
  if (!ms || !Number.isFinite(ms)) return null
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/**
 * Vídeo que o agente renderizou ou mostrou (video_render, motion_render,
 * show_video). O arquivo continua no projeto; o orbit-video:// serve com
 * Range, então o <video> busca posição sem baixar tudo.
 */
export function VideoPartView({ part }: { part: { src: string; title?: string; durationMs?: number; path?: string } }) {
  const { t } = useTranslation()
  const duration = formatDuration(part.durationMs)
  const title = part.title || t("video.generated")
  return (
    <div className="my-2 flex w-full max-w-2xl flex-col gap-1.5 rounded-xl border bg-muted/30 p-2.5">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Clapperboard className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={part.path ?? title}>
          {title}
        </span>
        {duration && <span className="shrink-0 tabular-nums">{duration}</span>}
        {part.path && (
          <button
            type="button"
            onClick={() => void window.ipcRenderer.invoke("shell:showItemInFolder", part.path)}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
            title={t("video.showInFolder")}
          >
            <FolderOpen className="size-3.5" />
          </button>
        )}
      </div>
      <video controls preload="metadata" src={part.src} className="max-h-[480px] w-full rounded-lg bg-black" />
    </div>
  )
}
