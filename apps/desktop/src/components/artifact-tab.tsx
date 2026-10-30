import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Download, Maximize2, MessageSquare, Minimize2, RotateCw, Trash2 } from "lucide-react"
import { ARTIFACT_SCHEME } from "@shared/media"
import type { MediaEntry } from "@shared/media"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ArtifactFrame, ArtifactToolbar, IconAction } from "@/src/components/ai/artifact-part"
import { artifactApi, mediaApi } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { useWorkspace } from "@/lib/workspace-context"
import { scrollToMessage } from "@/src/lib/message-jump"
import { FULLSCREEN_OVERLAY_CLASS } from "@/src/lib/fullscreen-overlay"
import { cn } from "@/lib/utils"

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * Artifact in fullscreen in the right panel tab — the same file as the card in the
 * conversation, with room to spare (dashboard, screen prototype).
 *
 * The tab keeps only the `artifactId`: the title and the revision come from the registry on every
 * opening, so a tab that stayed open while the agent called
 * update_artifact shows the new version when you come back.
 */
export function ArtifactTab({ artifactId, title }: { artifactId?: string; title: string }) {
  const { t, i18n } = useTranslation()
  const { setMode } = useWorkspace()
  const [entry, setEntry] = useState<MediaEntry | null>(null)
  const [missing, setMissing] = useState(false)
  const [reloads, setReloads] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!artifactId) return
    let cancelled = false
    // Artifact and document use the same tab: both are served as HTML
    // through orbit-artifact://.
    void mediaApi.list({ kind: ["artifact", "document"] }).then((entries) => {
      if (cancelled) return
      const found = entries.find((e) => e.id === artifactId) ?? null
      setEntry(found)
      setMissing(!found)
    })
    return () => {
      cancelled = true
    }
  }, [artifactId, reloads])

  // Same reason as the card in the conversation: the tab may be open while the agent
  // rewrites the artifact. The bump of `reloads` re-reads the registry (hence
  // it being in the deps of the effect above) and remounts the iframe.
  useEffect(
    () =>
      artifactApi.onUpdated((payload) => {
        if (payload.artifactId === artifactId) setReloads((n) => n + 1)
      }),
    [artifactId],
  )

  // Esc leaves fullscreen (the tab only listens while it is in it — outside, Esc belongs to
  // whoever has the focus).
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fullscreen])

  const onExport = useCallback(() => {
    if (artifactId) void artifactApi.export(artifactId)
  }, [artifactId])

  /** Opens the origin chat and scrolls to the message where the artifact appeared. */
  const showInChat = useCallback(async () => {
    const sessionId = entry?.sessionId
    if (!sessionId) return
    const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    if (!session) return
    const mode = session.mode === "code" ? "code" : "chat"
    setMode(mode)
    await useSessionStore.getState().selectSession(mode, session.id)
    setFullscreen(false)
    if (entry?.messageId) setTimeout(() => void scrollToMessage(entry.messageId!), 400)
  }, [entry, setMode])

  const onDelete = useCallback(async () => {
    if (!artifactId) return
    await mediaApi.remove([artifactId])
    setConfirmDelete(false)
    usePanelStore.getState().closeArtifactTabs([artifactId])
  }, [artifactId])

  if (!artifactId || missing) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {t("artifacts.unavailable")}
      </div>
    )
  }

  // Document: the registry id is the .md source, but what renders is the .html.
  const fileId = artifactId.endsWith(".md") ? artifactId.replace(/\.md$/, ".html") : artifactId
  const src = `${ARTIFACT_SCHEME}://${fileId}?rev=${entry?.revision ?? 1}&r=${reloads}`
  const revision = entry?.revision ?? 1

  return (
    <div
      className={cn(
        "group/artifact flex min-w-0 flex-1 flex-col overflow-hidden bg-sidebar",
        fullscreen && FULLSCREEN_OVERLAY_CLASS,
      )}
    >
      <ArtifactToolbar
        title={entry?.name || title}
        actions={
          <>
            <IconAction
              icon={RotateCw}
              label={t("artifacts.reload")}
              onClick={() => setReloads((n) => n + 1)}
            />
            <IconAction icon={Download} label={t("artifacts.export")} onClick={onExport} />
            <IconAction
              icon={fullscreen ? Minimize2 : Maximize2}
              label={t(fullscreen ? "artifacts.exitFullscreen" : "artifacts.fullscreen")}
              onClick={() => setFullscreen((v) => !v)}
            />
          </>
        }
      />
      <ArtifactFrame
        src={src}
        title={entry?.name || title}
        nonce={`${artifactId}:${entry?.revision ?? 1}:${reloads}`}
        className="flex-1"
      />

      {/* Footer only in fullscreen: in the narrow tab the chrome steals the height the
          artifact needs. Same mold as the media viewer — details on the left,
          actions on the right. */}
      {fullscreen && entry && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">{entry.name || title}</span>
          {revision > 1 && (
            <>
              <span>·</span>
              <span>{t("artifacts.revision", { n: revision })}</span>
            </>
          )}
          <span>·</span>
          <span>{formatDate(entry.createdAt, i18n.language)}</span>
          <span>·</span>
          <span>{formatBytes(entry.size)}</span>
          <div className="ml-auto flex items-center gap-1">
            {entry.sessionId && (
              <button
                type="button"
                onClick={() => void showInChat()}
                className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent hover:text-accent-foreground"
              >
                <MessageSquare className="size-3" />
                {t("media.openInChat")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="size-3" />
              {t("media.delete")}
            </button>
          </div>
        </div>
      )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("media.confirmDelete.title")}</DialogTitle>
            <DialogDescription>{t("media.confirmDelete.viewerSingle")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void onDelete()}>
              {t("media.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
