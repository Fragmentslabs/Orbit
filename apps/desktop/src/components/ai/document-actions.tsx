import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, Download, Library, Loader2 } from "lucide-react"
import { DOCUMENT_DOWNLOADS, type DocumentDownload } from "@shared/media"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { docsApi, documentApi } from "@/src/lib/ipc"
import { Hint } from "@/components/ui/hint"

/**
 * The two controls the document carries wherever it appears — the
 * conversation card and the panel canvas.
 *
 * They live here because both places need the SAME behavior: download
 * renders on the spot and can fail, promoting to source depends on a state that
 * changes from outside. Duplicating that in two components would guarantee that one of the two
 * fell behind.
 */

const LABEL: Record<DocumentDownload, string> = { md: "Markdown", pdf: "PDF", docx: "Word" }
const EXT: Record<DocumentDownload, string> = { md: ".md", pdf: ".pdf", docx: ".docx" }

/** Common style of both: a discreet pill, the size of the card header. */
const PILL = "h-6 gap-1 px-2 text-[11px] font-normal"

export function DocumentDownloadMenu({
  documentId,
  onError,
  beforeDownload,
  compact = false,
}: {
  documentId: string
  onError: (message: string) => void
  /** Runs before downloading — the canvas saves what was in the typing pause,
   *  otherwise the file would come out with the previous text. */
  beforeDownload?: () => Promise<void>
  /** Icon only — for the conversation card, where the button text would compete
   *  with the document title. */
  compact?: boolean
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState<DocumentDownload | null>(null)

  const download = useCallback(
    async (format: DocumentDownload) => {
      await beforeDownload?.()
      setBusy(format)
      try {
        const result = await documentApi.export(documentId, format)
        // Cancelling in the save dialog is not an error: the user gave up.
        if (!result.ok && !result.canceled) onError(result.error ?? t("sources.actionFailed"))
      } finally {
        setBusy(null)
      }
    },
    [documentId, beforeDownload, onError, t],
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          compact ? (
            <Hint label={t("documents.download")}>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={busy !== null}
                aria-label={t("documents.download")}

              />
            </Hint>
          ) : (
            <Button variant="outline" size="sm" className={PILL} disabled={busy !== null} />
          )
        }
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className={compact ? "size-3.5" : "size-3"} />}
        {!compact && t("documents.download")}
        {!compact && <ChevronDown className="size-3 opacity-60" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {DOCUMENT_DOWNLOADS.map((format) => (
          <DropdownMenuItem key={format} onClick={() => void download(format)}>
            {LABEL[format]}
            <span className="ml-auto pl-3 text-[10px] text-muted-foreground">{EXT[format]}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Promotes the document to a source of the conversation — and shows whether it ALREADY is one.
 *
 * The state is read from disk, not kept here: the source can be removed in the
 * Sources tab at any moment, and then the pill becomes clickable again. It is
 * `documents:changed` that warns, the same event that updates the Sources tab.
 */
export function DocumentSourceBadge({
  documentId,
  sessionId,
  onError,
  beforeAdd,
}: {
  documentId: string
  sessionId: string
  onError: (message: string) => void
  beforeAdd?: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [isSource, setIsSource] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void documentApi.isSource(sessionId, documentId).then(setIsSource)
  }, [sessionId, documentId])

  useEffect(refresh, [refresh])
  // Removing the source in the Sources tab has to release this pill back.
  useEffect(() => docsApi.onChanged(refresh), [refresh])

  const add = useCallback(async () => {
    await beforeAdd?.()
    setBusy(true)
    try {
      const result = await documentApi.useAsSource(sessionId, documentId)
      if (result.ok) setIsSource(true)
      else onError(result.error)
    } finally {
      setBusy(false)
    }
  }, [sessionId, documentId, beforeAdd, onError])

  return (
    <Hint label={isSource ? t("documents.isSource") : t("documents.useAsSource")}>
      <Button
        variant={isSource ? "secondary" : "outline"}
        size="sm"
        className={PILL}
        disabled={busy || isSource}
        onClick={() => void add()}
      >
        {
    busy ? <Loader2 className="size-3 animate-spin" /> : <Library className="size-3" />}
      {isSource ? t("documents.sourceBadgeOn") : t("documents.sourceBadgeOff")}
    </Button>
    </Hint>
  )
}
