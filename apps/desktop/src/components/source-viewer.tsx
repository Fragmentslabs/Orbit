import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  List,
  Loader2,
  Minus,
  Plus,
  Printer,
  Search,
  X,
} from "lucide-react"
import { splitDocxPages } from "@shared/page-breaks"
import { docsApi, documentApi, type OutlineItem, type RenderedPage, type SourceText } from "@/src/lib/ipc"
import { locateText, selectionScaleX } from "@/src/lib/pdf-text"
import { QuoteSelection, type QuoteAnchor } from "@/src/components/quote-selection"
import { MessageResponse } from "@/src/components/ai/message"
import { DocumentSourceBadge } from "@/src/components/ai/document-actions"
import { locateLines } from "@/src/lib/document-quote"
import { isHtmlDocument } from "@/src/lib/html-source"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Viewer of a source in the side panel, opened by clicking the attachment,
 * the Sources tab or a citation in the conversation.
 *
 * Two modes:
 *
 * - Original: the PDF pages drawn by us, with the cited excerpt (or the
 *   search) marked on top. It is not the Chromium native viewer because
 *   it is a closed plugin — the page can be pointed at through the URL, but not the
 *   content nor its search can be reached, and therefore there is no way to mark the
 *   excerpt. Marking inside the PDF requires drawing the PDF. The page is an image,
 *   and the selection comes from a transparent text layer positioned over the
 *   glyphs (see PageView).
 * - Text: the extracted text with numbered lines — where one selects and
 *   copies, and the same text the model read (it is what guarantees that line 28
 *   here is the line 28 it cited).
 *
 * What the native viewer gave for free is reimplemented here because
 * it was replaced: find, table of contents, zoom, print and download. Print is the
 * exception and keeps going through the native path — it is Chromium that knows how to paginate
 * a PDF for paper, and redoing that from our images would be worse
 * precisely where it needs to be faithful.
 */

/** Ceiling of lines rendered at once in Text mode. */
const MAX_LINES = 20_000
/** Pages per rendering call — the same ceiling as the rasterizer. */
const BATCH = 5
const ZOOM_MIN = 0.75
const ZOOM_MAX = 3
const ZOOM_STEP = 0.25
/** Reference scale, shown as 100% in the zoom control. */
const ZOOM_BASE = 1.5
/**
 * From this width on the tab fits the table of contents column (208px) without squashing
 * the page — ~470px of reading are left. Below that the table of contents goes down to the
 * footer, in chips. The right panel is resizable, so what decides is the
 * width RECEIVED by the tab, and not the window's.
 */
const OUTLINE_SIDE_MIN = 680

interface Match {
  page: number
  line: number
}

interface Focus {
  page: number
  /** Changes on every request, so that clicking the same item twice scrolls again. */
  nonce: number
}

/**
 * Page and lines of the selected excerpt, read from the DOM itself: each line
 * carries the number the model sees, and it is that number that goes in the citation
 * (#orbit-source/<doc>/p<page>L<line>). A selection that crosses pages cites
 * from the beginning and without a final line — saying "line 4 of page 3" when the
 * excerpt ends on page 4 would be a false coordinate.
 *
 * Outside the component because it depends on nothing of it: it is DOM reading.
 */
function resolveQuoteAnchor(range: Range): QuoteAnchor {
  const at = (node: Node | null) => {
    const el = node instanceof HTMLElement ? node : (node?.parentElement ?? null)
    const lineEl = el?.closest<HTMLElement>("[data-line]")
    const pageEl = el?.closest<HTMLElement>("[data-textpage]")
    return {
      page: pageEl ? Number(pageEl.dataset.textpage) : undefined,
      line: lineEl ? Number(lineEl.dataset.line) : undefined,
    }
  }
  const start = at(range.startContainer)
  const end = at(range.endContainer)
  if (!start.page || !start.line) return {}
  const samePage = end.page === start.page
  return {
    page: start.page,
    fromLine: start.line,
    toLine: samePage && end.line && end.line > start.line ? end.line : undefined,
  }
}

/**
 * Is the source a Markdown file stored as text (the .md attached in the chat or
 * promoted to a source)? The `.txt` does NOT enter: there what one expects is pure text, and
 * going or not through a Markdown renderer changes nothing.
 */
const MARKDOWN_SOURCE = /\.(md|markdown|mdx)$/i

function isMarkdownSource(doc: Pick<SourceText, "kind" | "filename"> | null | undefined): boolean {
  return !!doc && doc.kind === "text" && MARKDOWN_SOURCE.test(doc.filename)
}

/**
 * The source as one Markdown text.
 *
 * It joins the synthetic pages (the `.md` is paginated for the model's READING, ~3k
 * characters per page) with a blank line between them: without that the last paragraph
 * of one page would stick to the first of the next, and a document with a page broken
 * in the middle of a table would come out wrong.
 */
function markdownOf(doc: Pick<SourceText, "pages">): string {
  return doc.pages.map((p) => p.lines.join("\n")).join("\n\n")
}

export function SourceViewer({
  sessionId,
  docId,
  page,
  fromLine,
  toLine,
}: {
  sessionId?: string
  docId?: string
  page?: number
  fromLine?: number
  toLine?: number
}) {
  const { t } = useTranslation()
  const [data, setData] = useState<SourceText | null>(null)
  const [loading, setLoading] = useState(true)
  /**
   * How the document is drawn. "doc" exists for what is Markdown (the .md
   * attached or promoted): before it opened in Text, a list of numbered lines
   * in a monospaced font — the right content with the wrong face, which
   * is what made a .md look like a broken Word. The Text font stays
   * there for citing an excerpt with page and line.
   */
  const [mode, setMode] = useState<"original" | "text" | "doc">("text")
  const [query, setQuery] = useState("")
  const [matchIndex, setMatchIndex] = useState(0)
  const [findOpen, setFindOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [zoom, setZoom] = useState(ZOOM_BASE)
  const [focus, setFocus] = useState<Focus | null>(null)
  const [busy, setBusy] = useState<"print" | "export" | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * Is what is open a document the AGENT wrote (and not an attached
   * source)? Its PDF/DOCX open here, and the conversation now shows only a
   * card — so "use as source", which lived in the card, has to live where the
   * document is. Only the document registry knows how to answer.
   */
  const [agentDocument, setAgentDocument] = useState(false)
  useEffect(() => {
    let alive = true
    setAgentDocument(false)
    if (docId) {
      void documentApi.info(docId).then((info) => {
        if (alive) setAgentDocument(info !== null)
      })
    }
    return () => {
      alive = false
    }
  }, [docId])
  // The search was filled by the citation (and not typed): it is what keeps the
  // highlight stuck to the cited page instead of marking the sentence wherever it repeats.
  const [fromCitation, setFromCitation] = useState(false)
  // Read at the time of choosing the initial mode, and not a dep of the effect that
  // loads the file: a new citation in the SAME document only swaps the excerpt,
  // and reloading the whole text for that would be wasted work.
  const citedRef = useRef(false)
  citedRef.current = page !== undefined && fromLine !== undefined
  const anchorRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  /**
   * Width the tab received NOW — it is what decides whether the table of contents stays in a
   * column, next to the page, or lying in the footer, in chips. The right panel
   * is resizable, so no window breakpoint answers for it.
   *
   * Callback ref, and not an effect with a ref: the component returns before drawing
   * while there is no source, and a mount effect would never measure the element that
   * appears afterwards.
   */
  const [width, setWidth] = useState(0)
  const observerRef = useRef<ResizeObserver | null>(null)
  const rootRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    observerRef.current = observer
    setWidth(el.clientWidth)
  }, [])

  /**
   * The session that accompanies the request to the main process. A GALLERY document
   * (`doc_xxx.md`) is read by its own id — the main process does not even use the session on that
   * path —, so the panel with no active conversation (the Media tab open on the start
   * screen, for example) can open the document. Only a conversation source
   * (`docN`/`srcN`) needs the session, and that one always arrives with one. Before, the
   * viewer required both and gave up with "click a citation"
   * before asking for the file: the document existed and was never read.
   */
  const viewSession = sessionId ?? ""
  /** The whole Markdown for Document mode. */
  const markdownBody = useMemo(
    () =>
      data
        ? markdownOf(data)
            // `\pagebreak` is an instruction of the document renderer, not
            // content: in the viewer it would come out as loose text in the middle of the
            // prose (the synthetic page of the source no longer corresponds to it).
            .replace(/^[ \t]*\\pagebreak[ \t]*$/gm, "")
        : "",
    [data],
  )
  /**
   * Document mode belongs to what IS Markdown. A `.md` that holds an HTML page (a page
   * saved from the browser, an exported app) has nothing to render: the markup is parsed
   * as HTML, the sanitizer drops it and the text of the `<title>` is what is left
   * ("Orbit") on an empty page. That one opens in Text, which shows the file.
   */
  const markdown = isMarkdownSource(data) && !isHtmlDocument(markdownBody)
  /** Label of the type in the header — the extension when it exists, otherwise the type
   *  word. Same rule as the Sources tab list. */
  const typeLabel = data
    ? (data.kind !== "web"
        ? /\.([a-z][a-z0-9]{0,4})$/i.exec(data.filename.trim())?.[1]?.toUpperCase()
        : null) ?? t(`sources.kind.${data.kind}`)
    : null

  useEffect(() => {
    let alive = true
    if (!docId) return
    setLoading(true)
    setOutline([])
    void docsApi.text(viewSession, docId).then((result) => {
      if (!alive) return
      setData(result)
      setLoading(false)
      const body = result ? markdownOf(result) : ""
      // The document opens as it is whenever there is an original — including
      // coming from a citation in the PDF, where the highlight is drawn too. In
      // .docx the HTML document does not know how to mark the cited line: coming from
      // a citation it opens in Text, which does.
      setMode(
        result?.hasOriginal && !(citedRef.current && result.originalKind === "docx")
          ? "original"
          : // Markdown opens as a document, EXCEPT when coming from a citation: the
            // citation points at page and line, and only Text knows how to mark the line.
            // And except when the file is not Markdown at all — an HTML page saved with a
            // `.md` name loses everything in the render but the `<title>`.
            isMarkdownSource(result) && !citedRef.current && !isHtmlDocument(body)
            ? "doc"
            : "text",
      )
    })
  return () => {
      alive = false
    }
  }, [viewSession, docId])

  /**
   * Citation: the search enters already filled with the cited excerpt. It is the same
   * mechanism that marks the occurrence in the PDF and in the text, so the click lands
   * straight on the excerpt and one can still navigate the repetitions.
   *
   * Separate from the load because the document does not change when one clicks ANOTHER
   * citation of the same file — only the excerpt changes, and re-reading the text there would be
   * wasted work.
   */
  useEffect(() => {
    if (!data) return
    const cited = fromLine
      ? (data.pages.find((p) => p.num === page)?.lines.slice(fromLine - 1, toLine ?? fromLine) ?? [])
      : []
    const termo = cited.join(" ").trim()
    setFromCitation(termo.length >= 2)
    setQuery(termo.length >= 2 ? termo : "")
    setFindOpen(termo.length >= 2)
  }, [data, page, fromLine, toLine])

  const matches = useMemo<Match[]>(() => {
    const term = query.trim().toLowerCase()
    if (!data || term.length < 2) return []
    const found: Match[] = []
    for (const p of data.pages) {
      for (let i = 0; i < p.lines.length; i += 1) {
        if (p.lines[i].toLowerCase().includes(term)) found.push({ page: p.num, line: i + 1 })
        if (found.length >= 500) return found
      }
    }
    return found
  }, [data, query])

  useEffect(() => setMatchIndex(0), [query])

  // Coming from a citation, the current occurrence is the one of the cited page — the same sentence
  // may appear earlier in the document, and starting from the first would take the panel
  // to a place that is not the cited one.
  useEffect(() => {
    if (!fromCitation || matches.length === 0) return
    const targetIndex = matches.findIndex((m) => m.page === (page ?? 0))
    if (targetIndex > 0) setMatchIndex(targetIndex)
  }, [fromCitation, matches, page])

  // Walking through the occurrences takes Original mode along: the counter says 3/12 and
  // the page in view has to be the one of the third.
  const current = matches[matchIndex]
  useEffect(() => {
    if (current) setFocus({ page: current.page, nonce: Date.now() })
  }, [current])

  // Giant document in Text mode: rendering everything would be dozens of
  // thousands of nodes. It cuts at MAX_LINES, STARTING at the cited page — opening
  // a citation from page 400 and showing the first 300 would be worse than nothing.
  const visiblePages = useMemo(() => {
    if (!data) return []
    const start = Math.max(0, data.pages.findIndex((p) => p.num === (page ?? 0)))
    const out: typeof data.pages = []
    let lines = 0
    for (let i = start; i < data.pages.length; i += 1) {
      lines += data.pages[i].lines.length
      if (lines > MAX_LINES && out.length > 0) break
      out.push(data.pages[i])
    }
    return out
  }, [data, page])

  useLayoutEffect(() => {
    if (!data || loading || mode !== "text") return
    anchorRef.current?.scrollIntoView({ block: "center" })
  }, [data, loading, mode, page, fromLine, matchIndex])

  // Table of contents clicked in Text mode: it scrolls to the marker of that page.
  useLayoutEffect(() => {
    if (mode !== "text" || !focus) return
    textRef.current
      ?.querySelector(`[data-textpage="${focus.page}"]`)
      ?.scrollIntoView({ block: "start" })
  }, [mode, focus])

  if (!docId) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
        {t("sources.viewerEmpty")}
      </div>
    )
  }

  const citedPage = page ?? 0
  const term = query.trim().toLowerCase()
  const truncated = (data?.pages.length ?? 0) > visiblePages.length
  // The highlight ALWAYS comes from the search field — including in the citation, which enters
  // filling it. That way erasing the filter unmarks, which is what one expects from
  // a filter, instead of leaving a mark that can no longer be removed.
  const highlight = term.length >= 2 ? query.trim() : ""
  // Coming from the citation the highlight stays stuck to the cited page; by typing, it counts in
  // any of them.
  const highlightPage = fromCitation ? citedPage : null

  /**
   * Printing and downloading can fail (a format without a PDF version, a file that
   * vanished, a denied write). Before, the result was discarded and the button
   * simply did nothing — the error needs to reach whoever clicked.
   */
  const run = async (action: "print" | "export") => {
    setBusy(action)
    setError(null)
    const result =
      action === "print"
        ? await docsApi.print(viewSession, docId)
        : await docsApi.export(viewSession, docId)
    // Cancelling in the dialog is not an error: the user gave up.
    if (!result.ok && !("canceled" in result && result.canceled)) {
      setError(result.error ?? t("sources.actionFailed"))
    }
    setBusy(null)
  }

  const iconButton =
    "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40"


  return (
    <div ref={rootRef} className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-border/60 px-3 py-2">
        <Hint label={t("sources.outline")}>
          <button
            type="button"
            onClick={() => setOutlineOpen((open) => !open)}
            className={cn(iconButton, outlineOpen && "bg-primary/15 text-primary")}
          >
            <List className="size-3.5" />
          </button>
        </Hint>

        <div className="min-w-0 flex-1 px-1">
          <Truncate text={data?.filename ?? docId}>
            <p className="truncate text-xs font-medium text-foreground">{data?.filename ?? docId}</p>
          </Truncate>
          {/*
            The id shown is the CURRENT one, not the one that was clicked: dragging the
            file between the areas swaps doc1 for src1, and the citation recorded in the
            conversation keeps the old address. Saying "src1 (was doc1)" is
            what prevents the change from looking like the wrong file.
          */}
          <Truncate>
            <p className="truncate text-[11px] text-muted-foreground">
            {/* The TYPE before the id: "src1" does not say what the file is, and it is
                the first thing one looks for here. */}
            {typeLabel && <span className="font-medium text-foreground/75">{typeLabel} · </span>}
            {data?.id ?? docId}
            {data?.movedFrom ? ` · ${t("sources.movedFrom", { id: data.movedFrom })}` : ""}
            {data ? ` · ${t("sources.unitPages", { count: data.totalPages })}` : ""}
          </p>
          </Truncate>
        </div>

        {data && (data.hasOriginal || markdown) && (
          <div className="flex shrink-0 items-center rounded-md border border-border p-0.5">
            {(markdown ? (["doc", "text"] as const) : (["original", "text"] as const)).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                className={cn(
                  "cursor-pointer rounded px-2 py-0.5 text-[11px]",
                  mode === option
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(
                  option === "original"
                    ? "sources.modeOriginal"
                    : option === "doc"
                      ? "sources.modeDocument"
                      : "sources.modeText",
                )}
              </button>
            ))}
          </div>
        )}

        {mode === "original" && (
          <>
            <Hint label={t("sources.zoomOut")}>
              <button
                type="button"
                disabled={zoom <= ZOOM_MIN}
                onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))}
                className={iconButton}
              >
                <Minus className="size-3.5" />
              </button>
            </Hint>
            <span className="w-9 shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">
              {Math.round((zoom / ZOOM_BASE) * 100)}%
            </span>
            <Hint label={t("sources.zoomIn")}>
              <button
                type="button"
                disabled={zoom >= ZOOM_MAX}
                onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))}
                className={iconButton}
              >
                <Plus className="size-3.5" />
              </button>
            </Hint>
          </>
        )}

        <Hint label={t("sources.find")}>
          <button
            type="button"
            onClick={() => {
              // Find works over the numbered LINES: in the rendered
              // Markdown there is nothing to mark, so the search takes one along to
              // Text mode instead of opening a box that finds nothing.
              if (!findOpen && mode === "doc") setMode("text")
              setFindOpen((open) => !open)
            }}
            className={cn(iconButton, findOpen && "bg-primary/15 text-primary")}
          >
            <Search className="size-3.5" />
          </button>
        </Hint>
        {agentDocument && sessionId && docId && (
          <DocumentSourceBadge documentId={docId} sessionId={sessionId} onError={setError} />
        )}
        <Hint label={t("sources.download")}>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("export")}
            className={iconButton}
          >
       
           {busy === "export" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
        </button>
        </Hint>
        {/* PDF only: printing sends the file to Chromium, which paginates PDF for
            paper and does not know what to do with a .docx. */}
        {data?.originalKind === "pdf" && (
          <Hint label={t("sources.print")}>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run("print")}
              className={iconButton}
            >
       
               {busy === "print" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Printer className="size-3.5" />
            )}
          </button>
          </Hint>
        )}
        {data?.sourceUrl && (
          <a
            href={data.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className={iconButton}
            title={data.sourceUrl}
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 border-b border-border/60 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <p className="min-w-0 flex-1">{error}</p>
          <Hint label={t("common.dismiss")}>
            <button
              type="button"
              onClick={() => setError(null)}
              className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-destructive/20"
            >
              <X className="size-3" />
            </button>
          </Hint>
        </div>
      )}

      {findOpen && (
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
          <Search className="size-3 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setFromCitation(false)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.length > 0) {
                setMatchIndex((i) =>
                  e.shiftKey ? (i - 1 + matches.length) % matches.length : (i + 1) % matches.length,
                )
              }
              if (e.key === "Escape") setFindOpen(false)
            }}
            placeholder={t("sources.findPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {matches.length > 0
              ? `${matchIndex + 1}/${matches.length}`
              : query.trim().length >= 2
                ? "0"
                : ""}
          </span>
          <Hint label={t("common.previous")}>
            <button
              type="button"
              disabled={matches.length === 0}
              onClick={() => setMatchIndex((i) => (i - 1 + matches.length) % matches.length)}
              className="flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
            >
              <ChevronUp className="size-3" />
            </button>
          </Hint>
          <Hint label={t("common.next")}>
            <button
              type="button"
              disabled={matches.length === 0}
              onClick={() => setMatchIndex((i) => (i + 1) % matches.length)}
              className="flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
            >
              <ChevronDown className="size-3" />
            </button>
          </Hint>
          <Hint label={t("common.close")}>
            <button
              type="button"
              onClick={() => setFindOpen(false)}
              className="flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent"
            >
              <X className="size-3" />
            </button>
          </Hint>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* With space, the table of contents is the left column. Narrow, it leaves
            here and becomes the footer right below the content — see the end of this
            return. */}
        {outlineOpen && width >= OUTLINE_SIDE_MIN && (
          <OutlinePanel
            outline={outline}
            total={data?.totalPages ?? 0}
            onGo={(n) => setFocus({ page: n, nonce: Date.now() })}
            layout="side"
            unit={data?.originalKind === "docx" ? "block" : "page"}
          />
        )}

        {/*
          No spinner: swapping the whole document for a spin on every reload
          blinks the page the person is reading. While the text has not arrived,
          `data` is still the one from the previous read (or null on the first), and what
          appears is the missing message — which is the real state.
        */}
        {!data ? (
          // Empty while the first read has not come back: saying "it does not exist"
          // before having looked would be a lie, and a spinner would make the
          // document blink on every reload.
          <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
            {loading ? "" : t("sources.viewerMissing", { id: docId })}
          </div>
        ) : mode === "original" && data.originalKind === "docx" ? (
          <DocxOriginal
            sessionId={viewSession}
            docId={docId}
            zoom={zoom}
            docName={data.filename || docId}
            textPages={data.pages}
          />
        ) : mode === "original" ? (
          <OriginalPages
            sessionId={viewSession}
            docId={docId}
            total={data.totalPages}
            focus={focus ?? (citedPage ? { page: citedPage, nonce: 0 } : null)}
            highlight={highlight}
            highlightPage={highlightPage}
            zoom={zoom}
            onOutline={setOutline}
            docName={data.filename || docId}
            textPages={data.pages}
          />
        ) : mode === "doc" ? (
          // Markdown as a document: the same drawing as the agent's document
          // tab, because it is the same content. The citation here is the TEXT (without
          // resolve): the rendered one has neither page nor line, and inventing an
          // address would send the click to the wrong excerpt — whoever needs the
          // exact line uses Text mode.
          <div
            ref={textRef}
            className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-4 text-sm text-foreground"
          >
            <QuoteSelection
              containerRef={textRef}
              kind="source"
              docId={data.id || docId}
              name={data.filename || docId}
              readAloud
            />
            <MessageResponse>{markdownBody}</MessageResponse>
          </div>
        ) : (
          <div
            ref={textRef}
            className="flex-1 overflow-auto px-3 py-3 font-mono text-xs leading-relaxed"
          >
            <QuoteSelection
              containerRef={textRef}
              kind="source"
              docId={data.id || docId}
              name={data.filename || docId}
              resolve={resolveQuoteAnchor}
            />
            {visiblePages.map((p) => (
              <div key={p.num} data-textpage={p.num}>
                <div className="sticky top-0 z-10 -mx-3 mb-1 bg-background/95 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground backdrop-blur">
                  {p.label ?? t("sources.pageOf", { page: p.num, total: data.totalPages })}
                </div>
                {p.lines.map((line, i) => {
                  const n = i + 1
                  // The citation strip disappears along with the filter, for the same
                  // reason as the highlight in the PDF.
                  const cited =
                    fromCitation &&
                    p.num === citedPage &&
                    n >= (fromLine ?? 0) &&
                    n <= (toLine ?? fromLine ?? 0)
                  const isCurrentMatch = current?.page === p.num && current?.line === n
                  const isAnchor = term.length >= 2 ? isCurrentMatch : cited && n === fromLine
                  return (
                    <div
                      key={n}
                      data-line={n}
                      ref={isAnchor ? anchorRef : undefined}
                      className={cn(
                        "flex gap-3 rounded px-1",
                        cited && "bg-primary/15 ring-1 ring-inset ring-primary/30",
                        isCurrentMatch && "ring-1 ring-inset ring-amber-500/70",
                      )}
                    >
                      <span className="w-8 shrink-0 select-none text-right text-muted-foreground/50">
                        {n}
                      </span>
                      <span className="min-w-0 whitespace-pre-wrap break-words text-foreground">
                        <Marked text={line} term={term} />
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
            {truncated && (
              <p className="px-1 py-3 text-[11px] text-muted-foreground">
                {t("sources.truncatedView", { shown: visiblePages.length, total: data.totalPages })}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Narrow tab: the table of contents goes down to the footer, in chips, and gives back to the
          page the width a 208px column would take. It is the same drawing as the
          Slides tab — the list changes place according to the space, without one more
          button. `width === 0` is the first paint, before measuring: it draws
          nothing so as not to blink in the wrong position. */}
      {outlineOpen && width > 0 && width < OUTLINE_SIDE_MIN && (
        <OutlinePanel
          outline={outline}
          total={data?.totalPages ?? 0}
          onGo={(n) => setFocus({ page: n, nonce: Date.now() })}
          layout="strip"
          unit={data?.originalKind === "docx" ? "block" : "page"}
        />
      )}
    </div>
  )
}

/** Marks the occurrences of the term inside a line of Text mode. */
function Marked({ text, term }: { text: string; term: string }) {
  if (term.length < 2) return <>{text || " "}</>
  const parts: React.ReactNode[] = []
  const lower = text.toLowerCase()
  let at = 0
  for (;;) {
    const found = lower.indexOf(term, at)
    if (found < 0) break
    if (found > at) parts.push(text.slice(at, found))
    parts.push(
      <mark key={found} className="rounded bg-amber-300/60 text-foreground dark:bg-amber-500/40">
        {text.slice(found, found + term.length)}
      </mark>,
    )
    at = found + term.length
  }
  if (parts.length === 0) return <>{text || " "}</>
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

/**
 * Table of contents of the document. When the PDF does not bring one (most scanned
 * ones and printer-generated ones do not), it falls back to the page list — the panel
 * keeps serving to jump, which is what a table of contents is opened for.
 *
 * Two forms: column on the left when the tab is wide, a lying strip in the footer
 * when it is narrow. It is not a stored preference — the width is what decides, so
 * dragging the panel divider swaps the form right away.
 */
function OutlinePanel({
  outline,
  total,
  onGo,
  layout,
  unit,
}: {
  outline: OutlineItem[]
  total: number
  onGo: (page: number) => void
  /**
   * "side" = column on the left; "strip" = lying strip in the footer, for when the
   * tab is narrow. The SAME content in two forms — the width is what chooses.
   */
  layout: "side" | "strip"
  /**
   * What the list numbers. A PDF has pages inside the file; a .docx has
   * blocks — its pagination belongs to the editor, and writing "page" there would promise
   * something the file does not keep.
   */
  unit: "page" | "block"
}) {
  const { t } = useTranslation()
  const entries = outline.filter((item) => item.page !== null)
  const label = (page: number) =>
    t(unit === "block" ? "sources.blockOf" : "sources.pageOf", { page, total })

  if (layout === "strip") {
    return (
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border/60 px-3 py-1.5">
        <span className="shrink-0 pr-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {entries.length > 0
            ? t("sources.outline")
            : t(unit === "block" ? "sources.blocksLabel" : "sources.pagesLabel")}
        </span>
        {entries.length > 0
          ? entries.map((item, i) => (
              <button
                key={`${item.title}-${i}`}
                type="button"
                onClick={() => onGo(item.page as number)}
                className="flex shrink-0 cursor-pointer items-baseline gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                
                  <Truncate>
                      <span className="max-w-44 truncate">{item.title || "—"}</span>
                  </Truncate>
                <span className="tabular-nums opacity-60">{item.page}</span>
              </button>
            ))
          : Array.from({ length: total }, (_, i) => i + 1).map((n) => (
              <Hint label={label(n)}>
                <button
                  key={n}
                  type="button"
                  onClick={() => onGo(n)}
                  className="min-w-7 shrink-0 cursor-pointer rounded-full border border-border/60 px-2 py-0.5 text-center text-[11px] tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
                >
       
                       {n}
              </button>
              </Hint>
            ))}
      </div>
    )
  }

  return (
    <div className="w-52 shrink-0 overflow-auto border-r border-border/60 py-2">
      {entries.length > 0 ? (
        <ul>
          {entries.map((item, i) => (
            <li key={`${item.title}-${i}`}>
              <button
                type="button"
                onClick={() => onGo(item.page as number)}
                style={{ paddingLeft: `${0.75 + item.level * 0.75}rem` }}
                className="flex w-full cursor-pointer items-baseline gap-2 py-1 pr-2 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                
                  <Truncate>
                      <span className="min-w-0 flex-1 truncate">{item.title || "—"}</span>
                  </Truncate>
                <span className="shrink-0 tabular-nums opacity-60">{item.page}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p className="px-3 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            {t("sources.noOutline")}
          </p>
          <ul>
            {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
              <li key={n}>
                <button
                  type="button"
                  onClick={() => onGo(n)}
                  className="w-full cursor-pointer px-3 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {label(n)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * The PDF drawn by us, page by page.
 *
 * Three things happen over the same image, all of them from the TEXT ITEMS
 * that come with it:
 *
 * - the highlight, calculated HERE (locateText) and not in the main process. Before, every letter
 *   typed in the search asked for the page back, and the panel blinked
 *   "loading" on every key;
 * - the selection layer, transparent spans over the glyphs, which is what
 *   allows selecting and copying in a mode where the page is an image;
 * - the zoom, which changes the displayed WIDTH right away and only then swaps the image for
 *   a sharper one — without throwing away the one already on screen.
 *
 * The items come in a fraction of the page, so they serve any scale: changing the
 * zoom invalidates neither the highlight nor the selection.
 */
function OriginalPages({
  sessionId,
  docId,
  total,
  focus,
  highlight,
  highlightPage,
  zoom,
  onOutline,
  docName,
  textPages,
}: {
  sessionId: string
  docId: string
  total: number
  /** Displayable name, for the citation chip. */
  docName: string
  /** The SAME lines as Text mode: it is in them that the selected excerpt is
   *  found again to become a coordinate. */
  textPages: { num: number; lines: string[] }[]
  focus: Focus | null
  highlight: string
  /** Page in which the highlight is expected; null when it is a search, which
   *  may match in any of them. */
  highlightPage: number | null
  zoom: number
  onOutline: (outline: OutlineItem[]) => void
}) {
  const { t } = useTranslation()
  const [pages, setPages] = useState<Record<number, RenderedPage>>({})
  /** Scale already rendered for each batch — it is what decides whether it is worth asking again. */
  const renderedAt = useRef(new Map<number, number>())
  const inFlight = useRef(new Set<number>())
  const containerRef = useRef<HTMLDivElement>(null)
  const focusRef = useRef<HTMLDivElement>(null)

  const load = useCallback(
    async (first: number) => {
      const batch = Math.max(1, first - ((first - 1) % BATCH))
      if (inFlight.current.has(batch)) return
      // Already rendered AT THIS scale: it does not repeat. It is what avoids the "loading"
      // when scrolling back to a page that is already ready.
      if (renderedAt.current.get(batch) === zoom) return
      inFlight.current.add(batch)
      try {
        const result = await docsApi.render(sessionId, docId, batch, BATCH, {
          scale: zoom,
          includeText: true,
          includeOutline: renderedAt.current.size === 0,
        })
        if (!result) return
        if (result.outline.length > 0) onOutline(result.outline)
        renderedAt.current.set(batch, zoom)
        setPages((current) => {
          const next = { ...current }
          for (const p of result.pages) next[p.page] = p
          return next
        })
      } finally {
        inFlight.current.delete(batch)
      }
    },
    [sessionId, docId, zoom, onOutline],
  )

  // Switching document resets everything. Switching the ZOOM does not: the old images
  // stay on screen, stretched, while the new ones arrive — clearing would make the
  // document disappear on every zoom click.
  useEffect(() => {
    renderedAt.current.clear()
    inFlight.current.clear()
    setPages({})
  }, [sessionId, docId])

  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const n = Number((entry.target as HTMLElement).dataset.page)
          if (n) void load(n)
        }
      },
      // Generous margin: the page starts rendering before entering the screen,
      // otherwise the scroll always meets an empty rectangle.
      { root, rootMargin: "600px" },
    )
    for (const el of root.querySelectorAll("[data-page]")) observer.observe(el)
    return () => observer.disconnect()
  }, [load, total])

  useEffect(() => {
    if (focus) void load(focus.page)
  }, [focus, load])

  useLayoutEffect(() => {
    if (focus) focusRef.current?.scrollIntoView({ block: "start" })
  }, [focus, pages])

  return (
    <div ref={containerRef} className="flex-1 overflow-auto bg-muted/40 p-3">
      {/*
        Here the selection happens in the text layer drawn over the image:
        the pieces are positioned glyphs, with no line number in the DOM. The
        page comes from the data-page, and the line comes from searching the text itself
        back in the line list — the same one the model reads, which is what makes the
        citation point to the right place.
      */}
      <QuoteSelection
        containerRef={containerRef}
        kind="source"
        docId={docId}
        name={docName}
        resolve={(range, text) => {
          const el =
            range.startContainer instanceof HTMLElement
              ? range.startContainer
              : (range.startContainer.parentElement ?? null)
          const pageEl = el?.closest<HTMLElement>("[data-page]")
          const page = pageEl ? Number(pageEl.dataset.page) : undefined
          if (!page) return {}
          const lines = textPages.find((p) => p.num === page)?.lines
          const found = lines ? locateLines(lines, text) : null
          return found ? { page, ...found } : { page }
        }}
      />
      <div
        className="mx-auto flex flex-col gap-3"
        // The zoom is the displayed WIDTH. Redrawing at a larger scale only increases the
        // resolution: without this the image arrived sharper at the same size and the
        // button seemed to have no effect at all.
        style={{ width: `${(zoom / ZOOM_BASE) * 100}%`, maxWidth: `${48 * (zoom / ZOOM_BASE)}rem` }}
      >
        {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
          <PageView
            key={n}
            page={n}
            rendered={pages[n]}
            highlight={highlightPage === null || highlightPage === n ? highlight : ""}
            outerRef={n === focus?.page ? focusRef : undefined}
            label={t("sources.pageOf", { page: n, total })}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * The attached .docx, as a document.
 *
 * The panel draws PDF in image pages; Word it does not know how to draw, and that is
 * why the file arrives converted into HTML by the main process (docx-view.ts), already cleaned.
 * Here it becomes a sheet: white background over the gray of the panel, like the
 * PDF pages next to it, because that is how an attached document looks —
 * not like the app theme.
 *
 * The element styles are explicit because the Tailwind reset zeroes
 * headings, lists and tables: without them the document would go back to being a block of
 * running text, which is exactly what one wanted to leave behind.
 */
function DocxOriginal({
  sessionId,
  docId,
  zoom,
  docName,
  textPages,
}: {
  sessionId: string
  docId: string
  zoom: number
  docName: string
  textPages: { num: number; lines: string[] }[]
}) {
  const { t } = useTranslation()
  const [html, setHtml] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setHtml(null)
    setFailed(false)
    void docsApi.html(sessionId, docId).then((result) => {
      if (!alive) return
      if (result) setHtml(result.html)
      else setFailed(true)
    })
    return () => {
      alive = false
    }
  }, [sessionId, docId])

  const zoomScale = zoom / ZOOM_BASE

  /**
   * One sheet per explicit break. The .docx does not keep pagination — only the
   * breaks the author forced —, so that is what separates one page from the other;
   * the rest of the content keeps running, as in Word.
   */
  const sheets = useMemo(() => (html === null ? [] : splitDocxPages(html)), [html])

  return (
    <div ref={containerRef} className="flex-1 overflow-auto bg-muted/40 p-3">
      {/* The selected excerpt is found again in the extracted lines, the same ones
          the model reads — it is what gives page and line to the citation of a
          document that, drawn like this, has neither of the two. */}
      <QuoteSelection
        containerRef={containerRef}
        kind="source"
        docId={docId}
        name={docName}
        resolve={(_range, text) => {
          for (const page of textPages) {
            const found = locateLines(page.lines, text)
            if (found) return { page: page.num, ...found }
          }
          return {}
        }}
      />
      {failed ? (
        <p className="p-6 text-center text-xs text-muted-foreground">{t("sources.docxUnavailable")}</p>
      ) : html === null ? null : (
        sheets.map((sheet, i) => (
          <article
            key={i}
            className={cn(
              "mx-auto mb-4 bg-white px-[3em] py-[2.5em] leading-relaxed text-neutral-900 shadow-sm last:mb-0",
              "[&_h1]:mb-[0.5em] [&_h1]:mt-[0.8em] [&_h1]:text-[1.6em] [&_h1]:font-bold",
              "[&_h2]:mb-[0.5em] [&_h2]:mt-[0.8em] [&_h2]:text-[1.35em] [&_h2]:font-bold",
              "[&_h3]:mb-[0.4em] [&_h3]:mt-[0.7em] [&_h3]:text-[1.15em] [&_h3]:font-semibold",
              "[&_p]:mb-[0.6em] [&_strong]:font-semibold [&_em]:italic [&_u]:underline",
              "[&_ul]:mb-[0.6em] [&_ul]:list-disc [&_ul]:pl-[1.5em] [&_ol]:mb-[0.6em] [&_ol]:list-decimal [&_ol]:pl-[1.5em]",
              "[&_table]:my-[0.8em] [&_table]:w-full [&_table]:border-collapse",
              "[&_td]:border [&_td]:border-neutral-300 [&_td]:px-[0.5em] [&_td]:py-[0.3em] [&_td]:align-top",
              "[&_th]:border [&_th]:border-neutral-300 [&_th]:px-[0.5em] [&_th]:py-[0.3em] [&_th]:text-left",
              "[&_td_p]:mb-0 [&_th_p]:mb-0 [&_img]:max-w-full [&_a]:text-blue-700 [&_a]:underline",
              "[&_header]:mb-[1.5em] [&_header]:border-b [&_header]:border-neutral-200 [&_header]:pb-[0.8em]",
              "[&_footer]:mt-[1.5em] [&_footer]:border-t [&_footer]:border-neutral-200 [&_footer]:pt-[0.8em]",
              "[&_header_p]:mb-0 [&_footer_p]:mb-0 [&_footer]:text-[0.85em] [&_footer]:text-neutral-600",
            )}
            style={{ fontSize: `${14 * zoomScale}px`, maxWidth: `${48 * zoomScale}rem` }}
            // Safe by construction: the HTML comes out of mammoth, which only writes the
            // document structure, and goes through sanitizeDocxHtml in the main process.
            dangerouslySetInnerHTML={{ __html: sheet }}
          />
        ))
      )}
    </div>
  )
}

/** One page: the image, the highlight and the selection layer. */
function PageView({
  page,
  rendered,
  highlight,
  outerRef,
  label,
}: {
  page: number
  rendered?: RenderedPage
  highlight: string
  outerRef?: React.RefObject<HTMLDivElement>
  label: string
}) {
  const rects = useMemo(
    () => (rendered && highlight ? locateText(rendered.items, highlight) : []),
    [rendered, highlight],
  )
  const aspect = rendered && rendered.height > 0 ? rendered.width / rendered.height : 1
  const layerRef = useRef<HTMLDivElement>(null)

  /**
   * Adjusts the width of each span by MEASUREMENT, and not by estimate.
   *
   * The span has to occupy exactly the width that text occupies in the
   * image, otherwise the selection mark is too wide or too narrow in relation to the glyph. The
   * estimate by half height comes close but misses in condensed font,
   * small caps and numbers; measuring gets it right.
   *
   * `offsetWidth` is the LAYOUT width and ignores the transform, so it is possible to
   * read the natural width even with the previous scaleX applied — without having to
   * zero it first and trigger a second layout calculation.
   */
  useLayoutEffect(() => {
    const layer = layerRef.current
    if (!layer || !rendered) return
    const adjust = () => {
      const pageWidth = layer.clientWidth
      if (!pageWidth) return
      const spans = layer.children
      const natural: number[] = []
      for (let i = 0; i < spans.length; i += 1) natural.push((spans[i] as HTMLElement).offsetWidth)
      for (let i = 0; i < spans.length; i += 1) {
        const item = rendered.items[i]
        if (!item) continue
        const target = item.width * pageWidth
        const scale = natural[i] > 0 ? target / natural[i] : selectionScaleX(item, aspect)
        ;(spans[i] as HTMLElement).style.transform = `scaleX(${Math.min(3, Math.max(0.2, scale))})`
      }
    }
    adjust()
    // The zoom changes the width of the page: without re-observing, the layer would stay at the
    // previous scale.
    const observer = new ResizeObserver(adjust)
    observer.observe(layer)
    return () => observer.disconnect()
  }, [rendered, aspect])

  return (
    <div
      data-page={page}
      ref={outerRef}
      className="relative overflow-hidden rounded bg-background shadow-sm"
      style={{
        // A4 proportion while it has not rendered: without an approximate height the
        // list would collapse and everything would enter the screen at once, firing the
        // loading of the whole document.
        ...(rendered ? {} : { aspectRatio: "1 / 1.414" }),
        // WIDTH container (not size): the selection layer measures the
        // font in cqw, and that way it follows the zoom by itself. `size` would contain
        // the height too, and the page — which is sized by the image —
        // would collapse.
        containerType: "inline-size",
      }}
    >
      {rendered ? (
        <>
          <img src={rendered.dataUrl} alt={label} className="block w-full select-none" />
          {rects.map((rect, i) => (
            <span
              key={i}
              className="pointer-events-none absolute bg-amber-300/45 ring-1 ring-amber-500/50"
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.width * 100}%`,
                height: `${rect.height * 100}%`,
              }}
            />
          ))}
          {/* Selection layer: the visible text is in the pixel of the image, and
              these transparent spans exist only to give selection and copy.
              `selection:text-transparent` is what prevents the text from APPEARING
              when selected: without it Chromium paints the selected part with
              the system highlight color, ignoring the transparent one — and the
              text appeared over the image one, misaligned. */}
          <div ref={layerRef} className="pdf-text-layer absolute inset-0">
            {rendered.items.map((item, i) => (
              <span
                key={i}
                className="absolute origin-top-left whitespace-pre leading-none text-transparent"
                style={{
                  left: `${item.x * 100}%`,
                  top: `${item.y * 100}%`,
                  // The height of the item is a fraction of the page HEIGHT, and cqw
                  // measures the WIDTH: the proportion converts between the two.
                  fontSize: `${(item.height / aspect) * 100}cqw`,
                  // Initial estimate; the effect below corrects it by measurement.
                  transform: `scaleX(${selectionScaleX(item, aspect)})`,
                }}
              >
                {item.text}
              </span>
            ))}
          </div>
        </>
      ) : (
        // Page not rasterized yet. No spin: in a list of pages, each
        // one that enters the screen would light up its own, and the whole document gets
        // nervous while one scrolls. The number already says what it is — a sheet that
        // has not been drawn yet — and it fills itself in.
        <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground/60">
          {label}
        </div>
      )}
    </div>
  )
}

