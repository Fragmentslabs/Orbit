import { useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, ChevronDown, History, Undo2, MessageSquareText, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SessionInfo } from "@shared/chat"
import { useSessionStore } from "@/src/stores/session-store"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Bar shown above the input while a revert is active:
 * - Code mode: summary of the changed files that were undone + "Undo" (unrevert).
 * - Code mode without a snapshot: warning that the conversation was truncated, but the
 *   files could not be undone (filesRestored === false).
 * - Chat mode: it indicates that the conversation was truncated up to the reverted point.
 * - In both modes: what was undone outside the repository — pieces (motion,
 *   design, slides) and gallery items —, and what was PRESERVED for having
 *   changed afterwards (another conversation, panel edit, external file).
 * It can be closed with the X (it does not undo the revert, it only hides the bar).
 *
 * After an unrevert with conflicts, the same bar shows the transient
 * notice of what stayed intact.
 */
export function RevertBar({ session }: { session: SessionInfo }) {
  const { t } = useTranslation()
  const unrevert = useSessionStore((s) => s.unrevert)
  const revertUncertain = useSessionStore((s) => s.revertUncertain)
  const [revertingUncertain, setRevertingUncertain] = useState(false)
  const notice = useSessionStore((s) => (s.revertNotice?.sessionId === session.id ? s.revertNotice : null))
  const dismissNotice = useSessionStore((s) => s.dismissRevertNotice)
  const [showDiff, setShowDiff] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const revert = session.revert

  // Unrevert with conflicts: there is no active revert anymore, but what stayed intact
  // needs to be said — otherwise the person thinks everything came back.
  if (!revert) {
    if (!notice) return null
    const kept = notice.files.length + (notice.media?.conflicts ?? 0)
    const detail = [...notice.files, ...(notice.media?.conflictLabels ?? [])].join("\n")
    const noticeLabel = notice.filesError
      ? t("revert.unrevertFilesError")
      : kept === 1
        ? t("revert.unrevertKeptOne")
        : t("revert.unrevertKeptMany", { n: kept })
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 text-xs">
        <div className="flex items-center gap-2 px-3 py-2">
          <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
          
            <Truncate>
                <span className="flex-1 truncate" title={detail || undefined}>
                {noticeLabel}
                {!notice.filesError && <span className="text-muted-foreground"> {t("revert.keptHint")}</span>}
            </span>
            </Truncate>
          <Hint label={t("common.close")}>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={dismissNotice}

            >
              <X className="size-3.5" />
            </button>
          </Hint>
        </div>
      </div>
    )
  }
  if (dismissed) return null

  const isCode = Boolean(revert.files || revert.diff)
  const count = revert.files?.length ?? 0
  // Code mode without a snapshot: the truncation happened, but the filesystem could not
  // be restored — an explicit warning instead of treating it as a chat revert.
  // 'capture-failed' (restore failed) has its own message vs. 'no-snapshot'
  // (snapshot unavailable for the message) and 'no-end-snapshot' (the turn may
  // have written, but the final state was not recorded).
  const filesNotRestored = Boolean(session.directory) && revert.filesRestored === false
  const label = filesNotRestored
    ? revert.reason === "capture-failed"
      ? t("revert.filesRestoreFailed")
      : revert.reason === "no-end-snapshot"
        ? t("revert.filesNoEndSnapshot")
        : t("revert.filesNotRestored")
    : isCode
      ? count === 0
        ? t("revert.filesRevertedNone")
        : count === 1
          ? t("revert.filesRevertedOne")
          : t("revert.filesRevertedMany", { n: count })
      : t("revert.conversationReverted")

  // Media: pieces and gallery live in the app storage and have their own journal,
  // in both modes (see session/media-revert.ts).
  const media = revert.media
  const mediaFailed = media?.restored === false
  const mediaParts = [
    media?.pieces ? t("revert.mediaPieces", { count: media.pieces }) : null,
    media?.items ? t("revert.mediaItems", { count: media.items }) : null,
  ].filter(Boolean)
  const mediaLabel = mediaFailed
    ? t("revert.mediaFailed")
    : mediaParts.length > 0
      ? t("revert.mediaReverted", { what: mediaParts.join(", ") })
      : null

  // What changed after the turn and stayed intact.
  const filesKept = revert.conflicts ?? []
  const mediaKept = media?.conflicts ?? 0
  const keptParts = [
    filesKept.length > 0
      ? filesKept.length === 1
        ? t("revert.filesKeptOne")
        : t("revert.filesKeptMany", { n: filesKept.length })
      : null,
    mediaKept > 0
      ? mediaKept === 1
        ? t("revert.mediaKeptOne")
        : t("revert.mediaKeptMany", { n: mediaKept })
      : null,
  ].filter(Boolean)
  const keptLabel = keptParts.length > 0 ? keptParts.join(", ") : null
  // Changed during the turn, but not by the Orbit write tools (bash,
  // MCP, something from outside): it was not reverted — the person decides.
  const uncertain = revert.uncertain ?? []
  const uncertainLabel =
    uncertain.length === 0
      ? null
      : uncertain.length === 1
        ? t("revert.uncertainOne")
        : t("revert.uncertainMany", { n: uncertain.length })
  const uncertainDetail = uncertain.join("\n")
  const keptDetail = [...filesKept, ...(media?.conflictLabels ?? [])].join("\n")
  const warn = filesNotRestored || mediaFailed || Boolean(keptLabel)
  const title = [
    mediaLabel,
    keptLabel && `${keptLabel}${keptDetail ? `\n${keptDetail}` : ""}`,
    uncertainLabel && `${uncertainLabel}\n${uncertainDetail}`,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <div className="rounded-lg border bg-muted/40 text-xs">
      <div className="flex items-center gap-2 px-3 py-2">
        {warn
          ? <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
          : isCode || mediaLabel
            ? <History className="size-3.5 shrink-0 text-muted-foreground" />
            : <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />
        }
        <Truncate>
            <span className="flex-1 truncate" title={title || label}>
            {label}
            {mediaLabel && <span className={cn(mediaFailed && "text-amber-600 dark:text-amber-400")}> · {mediaLabel}</span>}
            {keptLabel && (
              <span
                className="text-amber-600 dark:text-amber-400"
                title={keptDetail || undefined}
              >
                {" "}· {keptLabel}
              </span>
            )}
            {uncertainLabel && (
              <span className="text-muted-foreground" title={uncertainDetail}>
                {" "}· {uncertainLabel}
              </span>
            )}
            <span className="text-muted-foreground"> — {t("revert.continueFromHere")}</span>
          </span>
        </Truncate>
        {revert.diff && (
          <button
            type="button"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => setShowDiff((v) => !v)}
          >
            {t("revert.diff")}
            <ChevronDown className={cn("size-3 transition-transform", showDiff && "rotate-180")} />
          </button>
        )}
        {uncertainLabel && (
          <Hint label={uncertainDetail}>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={revertingUncertain}
              onClick={() => {
                setRevertingUncertain(true)
                void revertUncertain(session.id).finally(() => setRevertingUncertain(false))
              }}
            >
       
               {t("revert.revertUncertain")}
          </Button>
          </Hint>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          onClick={() => void unrevert(session.id)}
        >
          <Undo2 className="size-3" />
          {t("revert.unrevert")}
        </Button>
        <Hint label={t("common.close")}>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setDismissed(true)}

          >
            <X className="size-3.5" />
          </button>
        </Hint>
      </div>
      {showDiff && revert.diff && (
        <pre className="max-h-56 overflow-auto border-t px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {revert.diff}
        </pre>
      )}
    </div>
  )
}
