import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { EyeIcon, PenLineIcon, X } from "lucide-react"
import { splitOnPageBreaks } from "@shared/page-breaks"
import { DocumentDownloadMenu, DocumentSourceBadge } from "@/src/components/ai/document-actions"
import { MessageResponse } from "@/src/components/ai/message"
import { QuoteSelection } from "@/src/components/quote-selection"
import { artifactApi, documentApi } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * The living document, opened next to the conversation: it is read in rendered Markdown
 * and edited in the same place, while the agent keeps writing into it.
 *
 * Here the source is the Markdown, and not the preview HTML that the conversation card
 * shows in an iframe — that is what makes the editing possible. The card remains
 * a snapshot: as soon as this tab writes, it gets the notice and reloads.
 *
 * Whoever was REQUESTED as a file (PDF, Word) does not arrive here: that one opens in the
 * document viewer, with a table of contents, zoom and printing, which is what one
 * wants from a finished file.
 *
 * TWO HANDS ON THE SAME FILE. The agent rewrites the whole document on every
 * update_document, so writing without knowing the other one's version erases work —
 * in both directions. That is why every write carries the revision it started from: if the
 * document moved on, it is REFUSED and the user is who decides, here in the notice, in
 * stead of the last one to write winning in silence.
 */

/** Typing pause that triggers the write. Short enough for the conversation
 *  card to follow, long enough not to write on every key. */
const AUTOSAVE_MS = 1200

export function DocumentTab({
  documentId,
  title,
  sessionId,
}: {
  documentId?: string
  title: string
  /** Sources scope: promoting is always to the conversation one is in. */
  sessionId?: string
}) {
  const { t } = useTranslation()
  const [markdown, setMarkdown] = useState<string | null>(null)
  /** The document in pages: the `\pagebreak` is an instruction, not text. */
  const pages = useMemo(() => splitOnPageBreaks(markdown ?? ""), [markdown])
  /** Reading area — it is from it that the quotable selection comes. */
  const readRef = useRef<HTMLDivElement>(null)
  const [missing, setMissing] = useState(false)
  const [mode, setMode] = useState<"edit" | "preview">("preview")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The revision that is on disk when the agent wrote over what
   *  we are editing. Non-null = the notice is standing and nothing is written until the
   *  user chooses. */
  const [conflict, setConflict] = useState<number | null>(null)

  /** What is on disk — it is the comparison that says whether there is something to write. */
  const savedRef = useRef<string | null>(null)
  /** The revision the current text started from. It goes in every write. */
  const baseRef = useRef<number | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  /** Writes in flight: the notice they fire comes back here, and cannot be
   *  read as "someone touched the document". */
  const savingRef = useRef(0)
  /** The most recent text. The write on exit cannot depend on the state: the
   *  effect cleanup would see it frozen at the value from when it mounted. */
  const latestRef = useRef<string | null>(null)
  latestRef.current = markdown
  const conflictRef = useRef<number | null>(null)
  conflictRef.current = conflict

  const load = useCallback(async () => {
    if (!documentId) return
    const found = await documentApi.source(documentId)
    if (!found) {
      setMissing(true)
      return
    }
    savedRef.current = found.markdown
    baseRef.current = found.revision
    setMarkdown(found.markdown)
    conflictRef.current = null
    setConflict(null)
  }, [documentId])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async () => {
    const text = latestRef.current
    if (!documentId || text === null || text === savedRef.current) return
    // Known conflict: insisting would only harvest the same refusal. The text stays
    // here, whole, until the user says what to do with it.
    if (conflictRef.current !== null) return
    window.clearTimeout(timerRef.current)
    savingRef.current += 1
    setSaving(true)
    try {
      const result = await documentApi.saveSource(documentId, text, baseRef.current ?? undefined)
      if (result.ok) {
        savedRef.current = text
        baseRef.current = result.revision
      } else if (result.reason === "stale") {
        conflictRef.current = result.revision
        setConflict(result.revision)
      } else {
        setError(t("documents.saveFailed"))
      }
    } finally {
      savingRef.current -= 1
      setSaving(false)
    }
  }, [documentId, t])

  const onChange = useCallback(
    (value: string) => {
      setMarkdown(value)
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => void save(), AUTOSAVE_MS)
    },
    [save],
  )

  // Leaving the tab (or the chat) cannot swallow what was in the typing
  // pause: what has not been written yet goes now.
  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current)
      void save()
    },
    [save],
  )

  // The agent writing in the SAME document. The notice carries the id of the preview
  // (.html); the document is the sibling .md.
  useEffect(() => {
    if (!documentId) return
    return artifactApi.onUpdated((payload) => {
      if (payload.artifactId.replace(/\.html$/, "") !== documentId.replace(/\.md$/, "")) return
      if (savingRef.current > 0 || payload.revision === baseRef.current) return
      // Reloading over an unsaved edit would erase what the user
      // has just written. With the text clean, the new version enters by itself;
      // with dirty text, they are the one who decides.
      if (latestRef.current !== savedRef.current) {
        conflictRef.current = payload.revision
        setConflict(payload.revision)
      } else {
        void load()
      }
    })
  }, [documentId, load])

  /** "Keep mine": adopts the disk revision as the basis and writes over it — a
   *  DELIBERATE discard of the agent's version, and not the chance of whoever wrote
   *  last. */
  const keepMine = useCallback(() => {
    baseRef.current = conflictRef.current
    conflictRef.current = null
    setConflict(null)
    void save()
  }, [save])

  const status = useMemo(() => {
    if (saving) return t("documents.saving")
    if (markdown !== null && markdown !== savedRef.current) return t("documents.unsaved")
    return t("documents.saved")
  }, [saving, markdown, t])

  if (!documentId || missing) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {t("documents.unavailable")}
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Truncate text={title}>
            <span className="truncate text-xs font-medium">{title}</span>
          </Truncate>
          <span className="shrink-0 text-[10px] text-muted-foreground">{status}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* They write before acting: the file and the source come from what is ON
              DISK, and what stayed in the typing pause would be left out. */}
          {sessionId && (
            <DocumentSourceBadge
              documentId={documentId}
              sessionId={sessionId}
              onError={setError}
              beforeAdd={save}
            />
          )}
          <DocumentDownloadMenu
            documentId={documentId}
            onError={setError}
            beforeDownload={save}
          />
          <div className="flex items-center gap-0.5 rounded-full border border-border bg-popover/90 p-0.5 shadow-sm backdrop-blur-xl">
            <Hint label={t("folders.editMode")}>
              <button
                type="button"
                onClick={() => setMode("edit")}
                className={cn(
                  "flex size-6 cursor-pointer items-center justify-center rounded-full transition-colors",
                  mode === "edit"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <PenLineIcon className="size-3.5" />
              </button>
            </Hint>
            <Hint label={t("folders.previewMode")}>
              <button
                type="button"
                // Going back to reading writes first: the card in the conversation shows
                // what is on disk, and lagging behind what was just written
                // would look like the edit was lost.
                onClick={() => {
                  void save()
                  setMode("preview")
                }}
                className={cn(
                  "flex size-6 cursor-pointer items-center justify-center rounded-full transition-colors",
                  mode === "preview"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <EyeIcon className="size-3.5" />
              </button>
            </Hint>
          </div>
        </div>
      </div>

      {conflict !== null && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-primary/10 px-3 py-1.5 text-[11px]">
          <p className="min-w-0 flex-1">{t("documents.externalChange")}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-medium hover:bg-primary/20"
          >
            {t("documents.loadTheirs")}
          </button>
          <button
            type="button"
            onClick={keepMine}
            className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-medium hover:bg-primary/20"
          >
            {t("documents.keepMine")}
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 border-b bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
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

      {markdown === null ? (
        <div className="p-4 text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : mode === "edit" ? (
        <textarea
          value={markdown}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-4 font-mono text-xs leading-5 text-foreground outline-none"
        />
      ) : (
        <div
          ref={readRef}
          className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-4 text-sm text-foreground"
        >
          {/* Without resolve: the living document has neither page nor line — the
              quoted excerpt is the text, and that is all the chip carries. */}
          {documentId && (
            <QuoteSelection
              containerRef={readRef}
              kind="document"
              docId={documentId}
              name={title}
              readAloud
            />
          )}
          {/* The `\pagebreak` is a renderer instruction, not content: here it
              appears as the separation between the pages, like in the PDF and the .docx. */}
          {pages.map((page, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <div className="my-5 flex items-center gap-3" aria-hidden>
                  <span className="h-px flex-1 bg-border" />
                  <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    {t("documents.pageBreak")}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <MessageResponse>{page}</MessageResponse>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}
