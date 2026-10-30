import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CodeXml, Download, Maximize2, Minus, PanelRight, Plus, RotateCw } from "lucide-react"
import type { ArtifactPart } from "@shared/chat"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { artifactApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * HTML artifact in the assistant reply (tool create_artifact): the page
 * renders HERE, in the flow of the conversation.
 *
 * The content is written by the model — which may have read the web in the same turn —
 * so it runs in an iframe `sandbox="allow-scripts"` WITHOUT `allow-same-origin`: the
 * document stays in an opaque origin, with no access to the Orbit window, no cookies
 * and no storage. Script runs (a dashboard without JS is good for nothing), but
 * confined. This combination is intentional: `allow-scripts` +
 * `allow-same-origin` together would let the artifact remove its own
 * sandbox.
 *
 * It is that opaque origin that explains why the scrollbar CANNOT come from the
 * app's ScrollArea: the component only styles what it scrolls itself, and from here
 * one cannot reach the DOM inside the iframe. What solves it is the main process, injecting the
 * style into the served HTML (see ARTIFACT_CHROME in electron/lib/media.ts).
 */

/**
 * Preview height as a fraction of the WINDOW, not in fixed pixels: fixed 420px
 * felt cramped for a dashboard, and the same height weighs differently on a
 * laptop and on a large monitor. The fraction keeps the relative presence
 * constant — tall enough for the artifact to make sense, low enough
 * for the conversation to remain visible around it.
 */
const PREVIEW_VIEWPORT_RATIO = 0.6
const MIN_PREVIEW_HEIGHT = 420

const SANDBOX = "allow-scripts allow-popups allow-forms allow-modals"

/**
 * Fullscreen zoom. The iframe is OUR element (unlike the scroll from
 * inside it), so it can be scaled from the outside. `transform: scale` with the size
 * INVERTED (width/height = 100/z) shrinks the iframe's internal viewport, and the
 * artifact reflows as in the browser zoom; only `scale` would scale the raster and the
 * text would come out blurry.
 *
 * `webFrame.setZoomFactor` is no use here: it is per webContents, and the iframe shares
 * the renderer with the app — it would zoom the whole Orbit interface.
 */
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP = 0.25
/**
 * Zoom when opening fullscreen. At 100% the artifact (dashboard, page) already fills the
 * dialog and looks too big; 75% fits with room to spare and still reads well. A multiple
 * of the step, so the +/− keeps landing on 50/75/100/125… The button's "100%"
 * goes back to THIS value — it is the starting point of the window, not the real size.
 */
const ZOOM_DEFAULT = 0.75

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))

function ArtifactFrame({
  src,
  title,
  className,
  style,
  nonce,
}: {
  src: string
  title: string
  className?: string
  style?: React.CSSProperties
  /** Changes to force the iframe remount (new revision or "reload"). */
  nonce: string
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)

  // Mirrors the app theme inside the iframe (see ARTIFACT_CHROME in media.ts):
  // the document is of an opaque origin and does not see the parent's classes.
  const sendTheme = useCallback(() => {
    const theme = document.documentElement.classList.contains("dark") ? "dark" : "light"
    frameRef.current?.contentWindow?.postMessage({ type: "orbit:theme", theme }, "*")
  }, [])

  useEffect(() => {
    const observer = new MutationObserver(sendTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [sendTheme])

  return (
    <iframe
      key={nonce}
      ref={frameRef}
      src={src}
      title={title}
      sandbox={SANDBOX}
      // The artifact must not be able to ask for camera/microphone/geolocation —
      // nothing in the use case justifies it, and the sandbox alone does not cover that.
      allow=""
      referrerPolicy="no-referrer"
      onLoad={sendTheme}
      className={cn("w-full border-0 bg-white", className)}
      style={style}
    />
  )
}

/**
 * Shared header of the artifact's three surfaces (card in the conversation,
 * panel tab, fullscreen).
 *
 * What made it look "marked" was the gray strip (bg-muted/50) added to the
 * full border; here the background is the card's own and only a hairline of separation remains. The
 * title drops to `text-muted-foreground` — it stays legible and stops
 * competing with the content, which is what the user came to see.
 */
function ArtifactToolbar({
  title,
  badge,
  actions,
  icon: Icon = CodeXml,
  className,
}: {
  title: string
  badge?: React.ReactNode
  actions: React.ReactNode
  icon?: typeof CodeXml
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1.5",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <Truncate text={title}>
          <span className="truncate text-xs font-medium text-muted-foreground">{title}</span>
        </Truncate>
        {badge}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover/artifact:opacity-100 focus-within:opacity-100">
        {actions}
      </div>
    </div>
  )
}

export function ArtifactPartView({
  part,
  sessionId,
}: {
  part: ArtifactPart
  /** Absent in contexts without a session (standalone history): the open-in-panel
   *  button disappears, since the tabs are per session. */
  sessionId?: string
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [reloads, setReloads] = useState(0)
  const openArtifactTab = usePanelStore((s) => s.openArtifactTab)

  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === 'undefined' ? 900 : window.innerHeight,
  )
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const previewHeight = Math.max(
    MIN_PREVIEW_HEIGHT,
    Math.round(viewportHeight * PREVIEW_VIEWPORT_RATIO),
  )

  // Reloads when the agent rewrites THIS artifact. The `part` of an
  // old message keeps the revision from when it was created and never changes —
  // without the notice from the main process, the top card would keep showing the old version
  // of the same file that the bottom card already shows updated.
  useEffect(
    () =>
      artifactApi.onUpdated(({ artifactId }) => {
        if (artifactId === part.artifactId) setReloads((n) => n + 1)
      }),
    [part.artifactId],
  )

  // The file is rewritten in place by update_artifact, so the URL alone
  // does not distinguish the revisions — without this the iframe would serve the old version.
  const src = useMemo(
    () => `${part.src}?rev=${part.revision ?? 1}&r=${reloads}`,
    [part.src, part.revision, reloads],
  )
  const nonce = `${part.artifactId}:${part.revision ?? 1}:${reloads}`

  const onExport = useCallback(() => {
    void artifactApi.export(part.artifactId)
  }, [part.artifactId])

  return (
    <>
      <div className="group/artifact not-prose my-2 w-full overflow-hidden rounded-lg border bg-background shadow-sm">
        <ArtifactToolbar
          title={part.title}
          badge={
            (part.revision ?? 1) > 1 && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t("artifacts.revision", { n: part.revision })}
              </span>
            )
          }
          actions={
            <>
              {/* Same order as the document card: download, reload, panel,
                  fullscreen — the same gesture in the same position on both cards. */}
              <IconAction icon={Download} label={t("artifacts.export")} onClick={onExport} />
              <IconAction
                icon={RotateCw}
                label={t("artifacts.reload")}
                onClick={() => setReloads((n) => n + 1)}
              />
              {sessionId && (
                <IconAction
                  icon={PanelRight}
                  label={t("artifacts.openInPanel")}
                  onClick={() => openArtifactTab(sessionId, part.artifactId, part.title)}
                />
              )}
              <IconAction
                icon={Maximize2}
                label={t("artifacts.expand")}
                onClick={() => setExpanded(true)}
              />
            </>
          }
        />
        <ArtifactFrame
          src={src}
          title={part.title}
          nonce={nonce}
          style={{ height: previewHeight }}
        />
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        {/*
          flex-col, and not DialogContent's default grid: with a fixed height, the
          implicit grid rows are STRETCHED (normal align-content becomes
          stretch), and the title row got half the dialog — the empty
          strip at the top, with the content pushed down. Same pattern as
          plan-dialog.
        */}
        <DialogContent className="flex h-[88vh] max-w-[92vw] flex-col gap-0 p-0">
          <DialogTitle className="shrink-0 border-b border-border/60 px-4 py-2 pr-12 text-sm font-medium">
            {part.title}
          </DialogTitle>
          {/* The zoom lives only here: in the card the preview is a fraction of the window and
              there is no room for the artifact to grow without pushing the conversation. */}
          <ArtifactStage src={src} title={part.title} nonce={`${nonce}:full`} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Stage of the artifact in fullscreen: applies the zoom and anchors the control bar.
 *
 * Mounts together with the dialog (the Dialog does not keep its content when closed),
 * so the zoom returns to the default on every opening — which is what one expects from a
 * freshly opened window.
 */
function ArtifactStage({ src, title, nonce }: { src: string; title: string; nonce: string }) {
  const [zoom, setZoom] = useState(ZOOM_DEFAULT)
  const stageRef = useRef<HTMLDivElement | null>(null)

  // Ctrl+wheel. The listener is native because `preventDefault` in a passive handler
  // (like React's) is ignored, and then Chromium would apply the WINDOW zoom to
  // the artifact instead.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom((z) => clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Ctrl + / − / 0, the same shortcut as any viewer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        setZoom((z) => clampZoom(z + ZOOM_STEP))
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        setZoom((z) => clampZoom(z - ZOOM_STEP))
      } else if (e.key === '0') {
        e.preventDefault()
        setZoom(ZOOM_DEFAULT)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden">
      <ArtifactFrame
        src={src}
        title={title}
        nonce={nonce}
        className="absolute top-0 left-0"
        style={{
          width: `${100 / zoom}%`,
          height: `${100 / zoom}%`,
          transform: `scale(${zoom})`,
          transformOrigin: 'top left',
        }}
      />
      <ZoomBar zoom={zoom} onChange={setZoom} />
    </div>
  )
}

/** Floating zoom controls — discreet over the content, no fixed bar. */
function ZoomBar({ zoom, onChange }: { zoom: number; onChange: (z: number) => void }) {
  const { t } = useTranslation()
  return (
    <div className="absolute right-3 bottom-3 z-10 flex items-center gap-0.5 rounded-full border border-border/60 bg-background/80 p-0.5 shadow-sm backdrop-blur-sm">
      <IconAction
        icon={Minus}
        label={t("artifacts.zoomOut")}
        disabled={zoom <= ZOOM_MIN}
        onClick={() => onChange(clampZoom(zoom - ZOOM_STEP))}
      />
      <button
        type="button"
        onClick={() => onChange(ZOOM_DEFAULT)}
        aria-label={t("artifacts.zoomReset")}
        className="min-w-11 rounded-full px-1 text-[11px] font-medium tabular-nums text-muted-foreground transition-colors hover:text-foreground"
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconAction
        icon={Plus}
        label={t("artifacts.zoomIn")}
        disabled={zoom >= ZOOM_MAX}
        onClick={() => onChange(clampZoom(zoom + ZOOM_STEP))}
      />
    </div>
  )
}

function IconAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
}: {
  icon: typeof RotateCw
  label: string
  onClick: () => void
  disabled?: boolean
  /**
   * ON RIGHT NOW (the list open, the notes showing). An icon just one shade
   * lighter read as hover; with a background, the state is evident at a glance and the button
   * matches the ToggleButton of the design inspector.
   */
  active?: boolean
}) {
  return (
    <Hint label={label}>
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "size-6",
          active ? "bg-primary/15 text-primary hover:bg-primary/20" : "text-muted-foreground",
        )}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}

      >
        <Icon className="size-3.5" />
      </Button>
    </Hint>
  )
}

export { ArtifactFrame, ArtifactToolbar, IconAction }
