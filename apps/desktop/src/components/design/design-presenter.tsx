import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, ArrowLeft, Expand, Frame, LayoutGrid, Loader2, Maximize2, Minimize2, Play, RotateCcw } from "lucide-react"
import { DESIGN_SCHEME } from "@shared/media"
import { IconAction } from "@/src/components/ai/artifact-part"
import { Button } from "@/components/ui/button"
import { FloatingSidebar } from "@/src/components/fullscreen-dock"
import { designApi } from "@/src/lib/ipc"
import { FULLSCREEN_OVERLAY_CLASS } from "@/src/lib/fullscreen-overlay"
import { cn } from "@/lib/utils"
import { DESIGN_SOURCE, boardForHref, parseRuntimeMessage } from "./design-protocol"
import { planDesignReload } from "./design-reload"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Presentation mode of the canvas, in its own tab: one screen at a time, in its own proportion
 * and fitted to the panel, and the links between the artboards (`<a href="Other.html">`)
 * really navigate — the prototype the user clicks, not the editing canvas.
 *
 * What intercepts the click is the artboard bridge (`play` mode): it does not let the
 * iframe navigate on its own — the panel is what knows WHICH screen comes next (and which
 * is the previous one, for going back), and the new screen always enters through the same route, with
 * the bridge injected.
 */

interface Board {
  file: string
  title?: string
  w: number
  h: number
}

interface CanvasFile {
  boards: Record<string, { title?: string; x: number; y: number; w: number; h: number }>
  order: string[]
}

const encodeFile = (file: string) => file.split("/").map(encodeURIComponent).join("/")

export function DesignPresenter({
  designId,
  title,
  startFile,
  initialFullscreen = false,
}: {
  designId: string
  title: string
  startFile: string
  /** The tab was born from the fullscreen editor: it already enters presenting like this. */
  initialFullscreen?: boolean
}) {
  const { t } = useTranslation()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [canvas, setCanvas] = useState<CanvasFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState(startFile)
  const [history, setHistory] = useState<string[]>([])
  const [reloads, setReloads] = useState(0)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [fullscreen, setFullscreen] = useState(initialFullscreen)
  // How the screen presents itself: "real" shows the frame at its own size (the screen
  // scrolls when it does not fit); "fit" scales it to fit entirely in the tab area.
  const [mode, setMode] = useState<"fit" | "real">("fit")
  // List of screens: floating bar on the left, in the mold of the sidebar of the editing
  // mode — pinnable open, or closed opening on the edge hover. Closed by
  // default so the screen is not born covered.
  const [screensOpen, setScreensOpen] = useState(false)

  const load = useCallback(() => {
    fetch(`${DESIGN_SCHEME}://${designId}/canvas.json?r=${Date.now()}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<CanvasFile>
      })
      .then((data) => {
        setCanvas(data)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [designId])

  useEffect(() => load(), [load])

  /** The screen that is in front, without re-subscribing the listener on every navigation. */
  const currentRef = useRef(current)
  currentRef.current = current

  // The agent touched the canvas: it reloads the screen the person is on — and only
  // when the change is of it, of the index or of a file it uses (CSS,
  // image, font). The watcher sends the names (see design-store.ts).
  useEffect(
    () =>
      designApi.onChanged((payload) => {
        if (payload.id !== designId) return
        const plan = planDesignReload(payload.files)
        if (plan.index) load()
        // The front screen only remounts if IT changed (or if the change may affect
        // any screen: CSS, image, folder font).
        if (plan.all || plan.boards.includes(currentRef.current)) setReloads((n) => n + 1)
      }),
    [designId, load],
  )

  // The Play of another artboard reuses the tab and only swaps the initial screen.
  useEffect(() => {
    setCurrent(startFile)
    setHistory([])
  }, [startFile])

  const boards = useMemo<Board[]>(() => {
    if (!canvas) return []
    return canvas.order.filter((file) => canvas.boards[file]).map((file) => ({ file, ...canvas.boards[file] }))
  }, [canvas])
  const files = useMemo(() => boards.map((b) => b.file), [boards])
  const board = boards.find((b) => b.file === current) ?? null

  const goTo = useCallback(
    (file: string, push = true) => {
      if (file === current) return
      if (push) setHistory((h) => [...h, current])
      setCurrent(file)
    },
    [current],
  )

  const back = useCallback(() => {
    setHistory((h) => {
      const previous = h[h.length - 1]
      if (previous === undefined) return h
      setCurrent(previous)
      return h.slice(0, -1)
    })
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = frameRef.current?.contentWindow
      if (!win || event.source !== win) return
      const msg = parseRuntimeMessage(event.data)
      if (!msg) return
      if (msg.type === "ready") {
        win.postMessage({ source: DESIGN_SOURCE, type: "mode", select: false, play: true }, "*")
      } else if (msg.type === "navigate") {
        const target = boardForHref(msg.href, files)
        if (target) goTo(target)
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [files, goTo])

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

  // Esc with the focus INSIDE the artboard arrives through the bridge (it cancels the keys).
  useEffect(() => {
    if (!fullscreen) return
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const msg = parseRuntimeMessage(event.data)
      if (msg?.type === "key" && msg.phase === "down" && msg.key === "Escape") setFullscreen(false)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [fullscreen])

  // The screen takes the whole stage, in its own proportion.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // "fit": scales by the WIDTH (the screen touches the sides, with no band) and the
  // height follows the proportion; if it becomes taller than the area, the stage scrolls
  // vertically instead of cutting behind the header. "real": original size.
  const scale = board && box.w > 0 && box.h > 0 ? box.w / board.w : 1
  const fit = mode === "fit"
  const overflowsY = fit && !!board && box.h > 0 && board.h * scale > box.h + 1

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar", fullscreen && FULLSCREEN_OVERLAY_CLASS)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 p-2">
        <div className="flex min-w-0 items-center gap-2">
          <Play className="size-3.5 shrink-0 text-muted-foreground" fill="currentColor" />
          <Truncate text={title}>
            <span className="truncate text-xs font-medium text-muted-foreground">{title}</span>
          </Truncate>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {history.length > 0 && <IconAction icon={ArrowLeft} label={t("design.present.back")} onClick={back} />}
          <IconAction
            icon={RotateCcw}
            label={t("design.present.restart")}
            onClick={() => {
              setHistory([])
              setCurrent(startFile)
              setReloads((n) => n + 1)
            }}
          />
          <div className="mx-1 h-4 w-px bg-border" />
          <Hint label={t("design.present.fit")}>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(fit && "bg-primary/15 text-primary hover:bg-primary/20")}
              aria-pressed={fit}

              aria-label={t("design.present.fit")}
              onClick={() => setMode("fit")}
            >
              <Expand className="size-3.5" />
            </Button>
          </Hint>
          <Hint label={t("design.present.real")}>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(!fit && "bg-primary/15 text-primary hover:bg-primary/20")}
              aria-pressed={!fit}

              aria-label={t("design.present.real")}
              onClick={() => setMode("real")}
            >
              <Frame className="size-3.5" />
            </Button>
          </Hint>
          <div className="mx-1 h-4 w-px bg-border" />
          <IconAction
            icon={fullscreen ? Minimize2 : Maximize2}
            label={t(fullscreen ? "design.exitFullscreen" : "design.fullscreen")}
            onClick={() => setFullscreen((v) => !v)}
          />
        </div>
      </div>

      <div
        ref={stageRef}
        className={cn(
          "relative flex min-h-0 flex-1 overflow-hidden bg-black/30",
          // "fit" fills the width; it centers vertically when it fits and scrolls
          // (aligned to the top) when the screen is taller than the area. "real"
          // leaves the frame at its own size and scrolls when it is bigger. With no screen
          // (loading/error), it centers the notice in any mode.
          !board
            ? "items-center justify-center"
            : fit
              ? cn(
                  "justify-center overflow-x-hidden",
                  overflowsY ? "items-start overflow-y-auto" : "items-center overflow-hidden",
                )
              : "overflow-auto",
        )}
      >
        {error && (
          <div className="flex items-center gap-2 text-[11px] text-destructive">
            <AlertTriangle className="size-3.5" />
            {error}
          </div>
        )}
        {!canvas && !error && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {canvas && !board && <p className="text-xs text-muted-foreground">{t("design.present.missing", { file: current })}</p>}
        {board && (
          <div
            className={cn(
              "relative overflow-hidden bg-white shadow-lg ring-1 ring-border/60",
              // `m-auto` centers with slack and, without slack, frees the scroll (the
              // flex `justify-center` clips the top/left in that case).
              !fit && "m-auto",
            )}
            style={fit ? { width: board.w * scale, height: board.h * scale } : { width: board.w, height: board.h }}
          >
            <iframe
              ref={frameRef}
              key={`${designId}:${current}:${reloads}`}
              src={`${DESIGN_SCHEME}://${designId}/${encodeFile(current)}?play=${reloads}`}
              title={board.title ?? current}
              sandbox="allow-scripts"
              allow=""
              referrerPolicy="no-referrer"
              className="absolute top-0 left-0 border-0"
              style={{
                width: board.w,
                height: board.h,
                transform: fit ? `scale(${scale})` : undefined,
                transformOrigin: "top left",
              }}
            />
          </div>
        )}

        {/* In fullscreen, the list of screens stays in the floating bar on the left —
            the same gesture as the sidebar of the editing mode (pinned open by the button, or
            opens on the edge hover when closed). In the panel (without fullscreen)
            it becomes the horizontal strip at the bottom. */}
        {fullscreen && boards.length > 1 && (
          <FloatingSidebar
            side="left"
            open={screensOpen}
            onToggle={() => setScreensOpen((v) => !v)}
            openLabel={t("design.present.showScreens")}
            closeLabel={t("design.present.hideScreens")}
          >
            <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-3 text-[11px] font-medium">
              <LayoutGrid className="size-3" />
              {t("design.present.screens")}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
              {boards.map((b) => (
                <button
                  key={b.file}
                  type="button"
                  onClick={() => goTo(b.file)}
                  className={cn(
                    "flex w-full items-center rounded-md px-2 py-1.5 text-left text-[11px] transition-colors",
                    b.file === current
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  
                    <Truncate>
                        <span className="truncate">{b.title ?? b.file}</span>
                    </Truncate>
                </button>
              ))}
            </div>
          </FloatingSidebar>
        )}
      </div>

      {/* In the panel (without fullscreen) the list of screens stays in the bottom strip,
          with the preview taking the rest on top. */}
      {!fullscreen && boards.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border/60 p-2">
          {boards.map((b) => (
            <Hint label={b.title ?? b.file}>
              <button
                key={b.file}
                type="button"
                onClick={() => goTo(b.file)}
                className={cn(
                  "shrink-0 rounded-md px-2.5 py-1 text-[11px] transition-colors",
                  b.file === current
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
       
                   <span className="block max-w-[10rem] truncate">{b.title ?? b.file}</span>
            </button>
            </Hint>
          ))}
        </div>
      )}
    </div>
  )
}
