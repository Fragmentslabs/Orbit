import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { FileText, X } from "lucide-react"
import type { DocumentPart } from "@shared/chat"
import { documentOpensAsFile } from "@shared/media"
import { DocumentDownloadMenu } from "@/src/components/ai/document-actions"
import { artifactApi, documentApi } from "@/src/lib/ipc"
import { openDocumentInPanel } from "@/src/lib/open-document"
import { firstLine } from "@/src/lib/document-preview"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Deliverable document in the reply (create_document, update_document,
 * docx_edit): report, proposal, minutes, evidence.
 *
 * In the conversation it is a CARD — title, type and the click to open —, and the
 * document itself lives in the side panel. It used to be the other way: the card drew the
 * whole document in the middle of the conversation, and a long report pushed the
 * agent's reply away from the question that asked for it. Besides that there were
 * two places showing the same text, and only one of them edited.
 *
 * The panel opens BY ITSELF when the document is born, in the turn in progress — it is the
 * moment when it is the subject. It does not open when going back to an old conversation
 * nor when scrolling the history, and it opens only once per document: whoever closed the
 * panel after that does not see it reopen on every update_document.
 */

/** Documents already opened automatically in this run of the app. */
const autoOpened = new Set<string>()

/**
 * Minimum window width to open the panel without asking. Below that the
 * panel would squeeze the conversation until it became unreadable — the card stays there
 * for whoever wants to open it.
 */
const AUTO_OPEN_MIN_WIDTH = 1100

/** Type and first line, read from the record — the part is only the snapshot of the turn. */
interface CardInfo {
  kind: string
  preview: string | null
}

export function DocumentPartView({
  part,
  sessionId,
  live = false,
}: {
  part: DocumentPart
  /** Absent in contexts without a session: the panel is per session, so the card
   *  is left without the open click. */
  sessionId?: string
  /** The message is being written right now — it is the only moment when the
   *  document opens by itself in the panel. */
  live?: boolean
}) {
  const { t } = useTranslation()
  const [info, setInfo] = useState<CardInfo | null>(null)
  const [reloads, setReloads] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const entry = await documentApi.info(part.documentId)
      if (!alive) return
      if (!entry || documentOpensAsFile(entry)) {
        const formats = entry?.delivery?.length ? entry.delivery : (entry?.formats ?? [])
        setInfo({
          kind: formats.length ? formats.map((f) => f.toUpperCase()).join(" · ") : t("documents.kindFile"),
          preview: null,
        })
        return
      }
      const source = await documentApi.source(part.documentId)
      if (alive) setInfo({ kind: "Markdown", preview: source ? firstLine(source.markdown) : null })
    })()
    return () => {
      alive = false
    }
  }, [part.documentId, reloads, t])

  // update_document rewrites in place: without this the first line of the card
  // would stay that of the previous version.
  useEffect(
    () =>
      artifactApi.onUpdated(({ artifactId }) => {
        if (artifactId.replace(/\.html$/, "") === part.documentId.replace(/\.md$/, "")) {
          setReloads((n) => n + 1)
        }
      }),
    [part.documentId],
  )

  useEffect(() => {
    if (!live || !sessionId) return
    const key = `${sessionId}:${part.documentId}`
    if (autoOpened.has(key)) return
    autoOpened.add(key)
    if (window.innerWidth < AUTO_OPEN_MIN_WIDTH) return
    void openDocumentInPanel(sessionId, part.documentId, part.title)
  }, [live, sessionId, part.documentId, part.title])

  const open = () => {
    if (sessionId) void openDocumentInPanel(sessionId, part.documentId, part.title)
  }

  return (
    <div className="not-prose my-2 w-full max-w-md">
      <div
        role={sessionId ? "button" : undefined}
        tabIndex={sessionId ? 0 : undefined}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            open()
          }
        }}
        title={sessionId ? t("artifacts.openInPanel") : undefined}
        className={`flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5 transition-colors ${
          sessionId ? "cursor-pointer hover:bg-accent/50" : ""
        }`}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
          <FileText className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <Truncate text={part.title}>
            <p className="truncate text-sm font-medium text-foreground">{part.title}</p>
          </Truncate>
          
            <Truncate>
              <p className="truncate text-[11px] text-muted-foreground">
              {info?.kind ?? " "}
              {(part.revision ?? 1) > 1 && ` · ${t("artifacts.revision", { n: part.revision })}`}
              {info?.preview && ` · ${info.preview}`}
            </p>
            </Truncate>
        </div>
        {/* Download does not open the panel: the click stops here. */}
        <div className="shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <DocumentDownloadMenu documentId={part.documentId} onError={setError} compact />
        </div>
      </div>

      {error && (
        <div className="mt-1 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <p className="min-w-0 flex-1">{error}</p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-destructive/20"
            aria-label={t("common.close")}
          >
            <X className="size-3" />
          </button>
        </div>
      )}
    </div>
  )
}
