import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  List,
  Loader2,
  Maximize2,
  Minimize2,
  Presentation,
  RotateCw,
  StickyNote,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconAction } from "@/src/components/ai/artifact-part"
import { FloatingSidebar } from "@/src/components/fullscreen-dock"
import { useSlidesDeck } from "@/src/components/slides/use-slides-deck"
import { slidesApi } from "@/src/lib/ipc"
import { TabHeader, TabHeaderSeparator } from "@/src/components/tab-header"
import { cn } from "@/lib/utils"
import { FULLSCREEN_OVERLAY_CLASS } from "@/src/lib/fullscreen-overlay"
import { Truncate } from "@/components/ui/truncated-text"

import { Hint } from "@/components/ui/hint"
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/**
 * The stage of a slides deck in the right panel tab.
 *
 * The iframe loads the registered FOLDER through `orbit-slides://<id>/<entry>`; the
 * bridge with the injected runtime lives in use-slides-deck.ts, shared with the
 * chat card. Here live the tab frame and the reins that belong to the interface:
 * the list, the presenter notes, the counter and fullscreen.
 *
 * The list changes place according to the space. In the narrow panel it is a strip
 * in the footer: a 208px column would eat precisely the width the 16:9
 * needs, and lying down the same information costs only height, only while open.
 * In FULLSCREEN, where there is room for both, it becomes the floating sidebar on the
 * right — the SAME component as the Design tab (FloatingSidebar): a panel with the
 * look of the app sidebar, a button next to it to toggle and opening by hover
 * on the edge when it is closed.
 */
export function SlidesTab({
  slidesId,
  entry,
  title,
}: {
  slidesId?: string
  entry?: string
  /** Displayable name of the deck (the registered folder). */
  title: string
}) {
  const { t } = useTranslation()
  const [showList, setShowList] = useState(true)
  /**
   * The FULLSCREEN list has its own state, and is born closed: there the deck is
   * being presented, and opening the sidebar over the stage (as the footer
   * strip stays by default in the narrow panel) would cover precisely the slide.
   * Closed, it opens on the edge hover or through the button next to it — the same
   * behavior as the Design FloatingSidebar.
   */
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  /** Printing in progress (a Chromium window) and its failure. */
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const { iframeRef, src, deck, index, total, current, loading, failed, go, reload } = useSlidesDeck({
    slidesId,
    entry,
    onFullscreenRequest: () => setFullscreen((value) => !value),
  })

  /**
   * Download as PDF. What prints is the main process, over index.html itself — the tab only
   * asks and shows the result. The suggested name is the deck name IN ORBIT (the
   * same as the tab and the gallery); the system dialog lets one change it.
   */
  const downloadPdf = useCallback(async () => {
    if (!slidesId || exporting) return
    setExporting(true)
    setExportError(null)
    try {
      const result = await slidesApi.exportPdf(slidesId, title)
      // Cancelling in the save dialog is not an error: the user gave up.
      if (!result.ok && !result.canceled) setExportError(result.error ?? t("slides.exportFailed"))
    } catch {
      setExportError(t("slides.exportFailed"))
    } finally {
      setExporting(false)
    }
  }, [slidesId, exporting, title, t])

  // Keyboard from OUTSIDE the iframe (with the focus on the tab bar). Inside the
  // stage the runtime is what handles it — the two do not run over each other, because a keydown
  // does not cross the iframe boundary.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase() ?? ""
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault()
        go(index + 1)
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault()
        go(index - 1)
      } else if (event.key === "Home") {
        event.preventDefault()
        go(0)
      } else if (event.key === "End") {
        event.preventDefault()
        go(total - 1)
      } else if (event.key === "f" || event.key === "F") {
        event.preventDefault()
        setFullscreen((value) => !value)
      } else if (event.key === "n" || event.key === "N") {
        event.preventDefault()
        setShowNotes((value) => !value)
      } else if (event.key === "Escape" && fullscreen) {
        setFullscreen(false)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fullscreen, go, index, total])

  // The list scrolls by itself to the current slide: in a deck of 20, the active row cannot
  // stay out of view just because the user advanced by keyboard.
  const activeRowRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" })
  }, [index])

  const progress = total > 0 ? ((index + 1) / total) * 100 : 0

  /**
   * The index as a list. The SAME content serves both places — the
   * footer strip in the narrow panel and the floating sidebar of fullscreen —,
   * so only the density changes: in the footer each row costs stage height, and
   * in the sidebar there is room to breathe. Real thumbnails would require one
   * render per slide (the iframe is opaque); the title is what one looks for when
   * navigating.
   */
  const slideRows = (dense: boolean) =>
    deck?.slides.map((slide, i) => (
      <Hint label={slide.title}>
        <button
          key={`${i}-${slide.title}`}
          ref={i === index ? activeRowRef : undefined}
          type="button"
          onClick={() => go(i)}
          className={cn(
            "flex w-full items-center gap-2 text-left transition-colors",
            dense ? "px-2.5 py-1.5 text-[11px]" : "rounded-md px-2.5 py-2 text-xs",
            i === index ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/40",
          )}
        >
       
       <span
          className={cn(
            "w-4 shrink-0 text-right tabular-nums opacity-60",
            dense ? "text-[10px]" : "text-[11px]",
          )}
        >
          {i + 1}
        </span>
        <span className="min-w-0 flex-1 truncate">{slide.title}</span>
        {slide.notes && <StickyNote className="size-2.5 shrink-0 opacity-50" />}
      </button>
      </Hint>
    ))

  if (!slidesId || !entry) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-sidebar p-6 text-center">
        <Presentation className="size-6 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">{t("slides.unavailable")}</p>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "group/slides flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar",
        fullscreen && FULLSCREEN_OVERLAY_CLASS,
      )}
    >
      {/* Header: deck + file on the left; list, notes, reload and full
          screen on the right. Same breathing room as the motion header. */}
      <TabHeader icon={Presentation} iconClassName="text-amber-400" title={title} tag={baseName(entry)}>
          {/* In fullscreen what opens and closes the list is the button of the floating
              sidebar, next to it (same drawing as the Design tab). */}
          {!fullscreen && (
            <IconAction
              icon={List}
              label={t("slides.toggleList")}
              active={showList}
              onClick={() => setShowList((v) => !v)}
            />
          )}
          <IconAction
            icon={StickyNote}
            label={t("slides.toggleNotes")}
            active={showNotes}
            onClick={() => setShowNotes((v) => !v)}
          />
          <TabHeaderSeparator />
          <IconAction
            icon={exporting ? Loader2 : Download}
            label={exporting ? t("slides.exporting") : t("slides.exportPdf")}
            onClick={downloadPdf}
            disabled={exporting || !slidesId}
          />
          <IconAction icon={RotateCw} label={t("slides.reload")} onClick={reload} />
          <IconAction
            icon={fullscreen ? Minimize2 : Maximize2}
            label={t(fullscreen ? "slides.exitFullscreen" : "slides.fullscreen")}
            onClick={() => setFullscreen((value) => !value)}
          />
        </TabHeader>

      {/* The PDF failure cannot replace the stage: a thin strip warns and the
          deck stays navigable. */}
      {exportError && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 bg-destructive/10 px-3 py-1 text-[0.6875rem] text-destructive">
          <AlertTriangle className="size-3 shrink-0" />
          <Truncate text={exportError}>
            <span className="min-w-0 flex-1 truncate">{exportError}</span>
          </Truncate>
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="shrink-0 underline underline-offset-2"
          >
            {t("slides.dismiss")}
          </button>
        </div>
      )}

      {/* The stage. The iframe takes the whole area and the runtime handles the scale — the
          same image at any panel size. */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <iframe
          ref={iframeRef}
          // The URL changes on every reload (the file is rewritten in place), so
          // it is the key of the remount.
          key={src}
          src={src}
          title={title}
          // WITHOUT allow-same-origin on purpose: `allow-scripts` + same-origin
          // would let the deck remove its own sandbox.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0 bg-black"
        />
        {loading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-black/40 text-xs text-white/70">
            <Loader2 className="size-3.5 animate-spin" />
            {t("slides.loading")}
          </div>
        )}
        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-4 text-center">
            <AlertTriangle className="size-4 text-destructive" />
            <span className="text-xs font-medium text-white">{t("slides.loadFailed")}</span>
            <span className="max-w-full break-words text-[11px] text-white/60">{failed}</span>
            <Button variant="outline" size="sm" onClick={reload}>
              {t("slides.retry")}
            </Button>
          </div>
        )}

        {/* Fullscreen: the list floats on the right, over the stage, with the
            look of the app sidebar. Closed, touching the edge opens it; the
            button next to it toggles and stays clickable to reopen. */}
        {fullscreen && (
          <FloatingSidebar
            side="right"
            open={sidebarOpen}
            onToggle={() => setSidebarOpen((value) => !value)}
            openLabel={t("slides.showList")}
            closeLabel={t("slides.hideList")}
          >
            <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-3 text-[11px] font-medium">
              <List className="size-3" />
              {t("slides.toggleList")}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">{slideRows(false)}</div>
          </FloatingSidebar>
        )}
      </div>

      {/* Presenter notes — what to SAY on this slide, off screen. */}
      {showNotes && (
        <div className="max-h-32 shrink-0 overflow-y-auto border-t border-border/60 bg-sidebar px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            <StickyNote className="size-3" />
            {t("slides.notes")}
          </div>
          {current?.notes ? (
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">{current.notes}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{t("slides.noNotes")}</p>
          )}
        </div>
      )}

      {/* Narrow panel: the list is a strip in the footer, stacked above the
          transport. In fullscreen it leaves here and becomes the floating sidebar. */}
      {!fullscreen && showList && !!deck?.slides.length && (
        <div className="max-h-56 shrink-0 overflow-y-auto border-t border-border/60">{slideRows(true)}</div>
      )}

      {/* Transport: previous, counter, next — and the progress bar
          stuck to the footer, which is what one looks at from afar. */}
      <div className="relative flex shrink-0 items-center justify-center gap-1 border-t border-border/60 p-1.5">
        <IconAction
          icon={ChevronLeft}
          label={t("slides.previous")}
          onClick={() => go(index - 1)}
          disabled={index <= 0}
        />
        <span className="min-w-16 text-center text-[0.6875rem] tabular-nums text-muted-foreground">
          {total > 0 ? t("slides.counter", { index: index + 1, total }) : "—"}
        </span>
        <IconAction
          icon={ChevronRight}
          label={t("slides.next")}
          onClick={() => go(index + 1)}
          disabled={total === 0 || index >= total - 1}
        />
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-muted">
          <div
            className="h-full bg-primary transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  )
}
