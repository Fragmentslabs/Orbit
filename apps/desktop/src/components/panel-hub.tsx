import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronRight, ImageOff } from "lucide-react"
import { assetUrl, mediaKind, thumbUrl, type MediaEntry } from "@shared/media"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useTheme } from "@/components/theme-provider"
import { useWorkspace } from "@/lib/workspace-context"
import { cn } from "@/lib/utils"
import { mediaApi } from "@/src/lib/ipc"
import { groupMediaByRoot } from "@/src/lib/media-groups"
import { KIND_ICON } from "@/src/lib/media-kind-icon"
import { CREATIONS } from "@/src/lib/creation-kinds"
import { startCreation } from "@/src/lib/start-creation"
import { useSessionStore } from "@/src/stores/session-store"

const RECENT_COUNT = 4

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</p>
}

/**
 * "Create": one card per kind of piece. A click opens a new chat with the ready-made message in
 * the composer (see startCreation) — it does not send anything, the person completes the fields.
 */
export function CreateCards() {
  const { t } = useTranslation()
  const { mode } = useWorkspace()
  return (
    <section className="flex flex-col gap-2.5">
      <SectionTitle>{t("panel.hub.create")}</SectionTitle>
      <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
        {CREATIONS.map(({ kind, Icon, tone }) => (
          <button
            key={kind}
            type="button"
            title={t("panel.hub.createHint")}
            onClick={() => void startCreation(mode, kind, t(`panel.hub.${kind}.prompt`))}
            className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-sidebar-border bg-card px-1 pt-3.5 pb-3 text-xs transition-colors hover:bg-sidebar-accent"
          >
            <span className={cn("flex size-8 items-center justify-center rounded-lg", tone)}>
              <Icon className="size-[17px]" />
            </span>
            {t(`panel.hub.${kind}.label`)}
          </button>
        ))}
      </div>
    </section>
  )
}

function RecentTile({ entry, onOpen }: { entry: MediaEntry; onOpen: () => void }) {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  const [failed, setFailed] = useState(false)
  const kind = mediaKind(entry)
  const KindIcon = KIND_ICON[kind]
  const preview = thumbUrl(entry, isDark)
  return (
    <button type="button" onClick={onOpen} className="group flex min-w-0 cursor-pointer flex-col gap-1 text-left">
      <span className="relative block aspect-square overflow-hidden rounded-xl border border-sidebar-border bg-muted/30 transition-colors group-hover:border-ring">
        {failed || !preview ? (
          <span className="flex size-full items-center justify-center text-muted-foreground">
            <ImageOff className="size-4" />
          </span>
        ) : (
          <img src={preview} alt={entry.name ?? entry.id} loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" />
        )}
        <span title={t(`media.kind.${kind}`)} className="absolute bottom-1 left-1 flex items-center rounded bg-background/85 px-1 py-0.5 text-foreground">
          <KindIcon className="size-3" />
        </span>
      </span>
      <span className="truncate text-[11px] text-muted-foreground">{entry.name || entry.id}</span>
    </button>
  )
}

/**
 * "Recent": the last pieces generated in the current mode. A piece with a tab of its own opens
 * there (`onOpenEntry` answers false for image, video and audio, which open in a viewer right here);
 * "see all" goes to the Media tab.
 */
export function RecentMedia({ onOpenEntry, onSeeAll }: { onOpenEntry: (entry: MediaEntry) => boolean; onSeeAll: () => void }) {
  const { t } = useTranslation()
  const { mode } = useWorkspace()
  const sessions = useSessionStore((s) => s.sessions)
  const [entries, setEntries] = useState<MediaEntry[]>([])
  const [preview, setPreview] = useState<MediaEntry | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => void mediaApi.list().then((list) => alive && setEntries(list)).catch(() => {})
    load()
    const off = mediaApi.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [])

  const recent = useMemo(() => {
    const ofMode = new Set(sessions.filter((s) => s.mode === mode).map((s) => s.id))
    const scoped = entries.filter((entry) => !entry.sessionId || ofMode.has(entry.sessionId))
    // One tile per original piece (its versions stay behind it), the newest first.
    const { covers } = groupMediaByRoot(scoped, scoped)
    return [...covers].sort((a, b) => b.createdAt - a.createdAt).slice(0, RECENT_COUNT)
  }, [entries, sessions, mode])

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center">
        <div className="flex-1"><SectionTitle>{t("panel.hub.recent")}</SectionTitle></div>
        <button
          type="button"
          onClick={onSeeAll}
          className="flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("panel.hub.seeAll")}
          <ChevronRight className="size-3" />
        </button>
      </div>
      {recent.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">{t("panel.hub.recentEmpty")}</p>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {recent.map((entry) => (
            <RecentTile key={entry.id} entry={entry} onOpen={() => { if (!onOpenEntry(entry)) setPreview(entry) }} />
          ))}
        </div>
      )}
      {/* What has no tab of its own (image, video, audio) opens right here, like in the gallery. */}
      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-5xl p-2">
          <DialogTitle className="sr-only">{preview?.name ?? preview?.id ?? ""}</DialogTitle>
          {preview && mediaKind(preview) === "video" && preview.videoUrl ? (
            <video key={preview.id} src={preview.videoUrl} controls autoPlay className="max-h-[76vh] w-full rounded-md bg-black object-contain" />
          ) : preview && mediaKind(preview) === "audio" ? (
            <audio key={preview.id} src={assetUrl(preview)} controls autoPlay className="w-full" />
          ) : preview ? (
            <img src={`orbit-media://${preview.id}`} alt={preview.name ?? preview.id} className="max-h-[76vh] w-full rounded-md object-contain" />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  )
}
