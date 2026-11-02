import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  Maximize2Icon,
  Minimize2Icon,
  MonitorIcon,
  MousePointerClickIcon,
  RefreshCcwIcon,
  SmartphoneIcon,
  SparklesIcon,
  TabletIcon,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { FULLSCREEN_OVERLAY_CLASS } from "@/src/lib/fullscreen-overlay"
import {
  WebPreview,
  WebPreviewBody,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
  WebPreviewBackButton,
  WebPreviewForwardButton,
  WebPreviewReloadButton,
  WebPreviewOpenInNewTabButton,
  useWebPreview,
} from "@/src/components/ai/web-preview"
import { FeedPinButton, FullscreenChatFeed, FullscreenComposer, useEdgeHover } from "@/src/components/fullscreen-dock"
import {
  applySelectMode,
  navigateWebview,
  reloadWebview,
} from "@/src/components/browser/webview-session"
import { RunningServers } from "@/src/components/running-servers"
import { usePanelStore, type Viewport } from "@/src/stores/panel-store"
import { Truncate } from "@/components/ui/truncated-text"

import { Hint } from "@/components/ui/hint"
/**
 * Browser tab of the right panel, controllable by the agent (panel_* tools):
 * - registers the webContents of the <webview> in the main process (panel:register)
 * - navigation from the URL bar is controlled (loadURL), without remounting the webview
 * - selection mode: a click on an element becomes a badge/attachment in the code mode input
 * - viewport (responsiveness), fullscreen with activity feed and composer for the AI
 */

const VIEWPORT_PRESETS: { icon: typeof MonitorIcon; labelKey: string; viewport: Viewport | null }[] = [
  { icon: MonitorIcon, labelKey: "browser.viewportFit", viewport: null },
  { icon: SmartphoneIcon, labelKey: "browser.viewportMobile", viewport: { width: 390, height: 844, label: "mobile" } },
  { icon: TabletIcon, labelKey: "browser.viewportTablet", viewport: { width: 834, height: 1112, label: "tablet" } },
  { icon: MonitorIcon, labelKey: "browser.viewportDesktop", viewport: { width: 1440, height: 900, label: "desktop" } },
]

/**
 * Tab body: it only coordinates intentions (navigate, reload, enable selection).
 * What talks to the `<webview>` is the pool (webview-session.ts) — no API of the
 * guest is called from here, because the guest is recreated on every re-parent and a
 * call at the wrong moment throws and takes down the whole React tree.
 */
function PanelBrowserBody({
  persistKey,
  onUrlChange,
}: {
  persistKey?: string
  onUrlChange?: (url: string) => void
}) {
  const { url, refreshKey } = useWebPreview()
  const selectMode = usePanelStore((s) => s.selectMode)
  const viewport = usePanelStore((s) => s.viewport)
  const initialSrcRef = useRef(url)

  // Controlled navigation: the URL bar asks, the pool applies when it can.
  useEffect(() => {
    if (!persistKey || !url) return
    navigateWebview(persistKey, url)
  }, [url, persistKey])

  // Selection mode — the pool also re-injects it on every new guest (dom-ready).
  useEffect(() => {
    if (!persistKey) return
    applySelectMode(persistKey, selectMode)
  }, [selectMode, persistKey])

  useEffect(() => {
    if (refreshKey <= 0 || !persistKey) return
    reloadWebview(persistKey)
  }, [refreshKey, persistKey])

  return (
    <WebPreviewBody
      src={initialSrcRef.current || undefined}
      onNavigate={onUrlChange}
      viewport={viewport}
      persistKey={persistKey}
    />
  )
}

function SelectModeButton() {
  const selectMode = usePanelStore((s) => s.selectMode)
  const setSelectMode = usePanelStore((s) => s.setSelectMode)
  const { t } = useTranslation()
  return (
    <WebPreviewNavigationButton
      tooltip={selectMode ? t("browser.selecting") : t("browser.selectForAgent")}
      onClick={() => setSelectMode(!selectMode)}
      className={cn(selectMode && "bg-emerald-500/15 text-emerald-500 hover:text-emerald-400")}
    >
      <MousePointerClickIcon className="size-4" />
    </WebPreviewNavigationButton>
  )
}

function ViewportButton() {
  const viewport = usePanelStore((s) => s.viewport)
  const setViewport = usePanelStore((s) => s.setViewport)
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title={t("browser.viewportTitle")}
        className={cn(
          "flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
          viewport && "text-foreground",
        )}
      >
        {viewport ? <SmartphoneIcon className="size-4" /> : <MonitorIcon className="size-4" />}
        {viewport && <span className="tabular-nums">{viewport.width}px</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {VIEWPORT_PRESETS.map((preset) => (
          <DropdownMenuItem key={preset.labelKey} onClick={() => setViewport(preset.viewport)}>
            <preset.icon className="size-3.5" />
            {t(preset.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FullscreenButton() {
  const fullscreen = usePanelStore((s) => s.fullscreen)
  const setFullscreen = usePanelStore((s) => s.setFullscreen)
  const { t } = useTranslation()
  return (
    <WebPreviewNavigationButton
      tooltip={fullscreen ? t("browser.exitFullscreen") : t("browser.enterFullscreen")}
      onClick={() => setFullscreen(!fullscreen)}
    >
      {fullscreen ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
    </WebPreviewNavigationButton>
  )
}

/** Indicator that the agent is driving the browser (badge in side mode). */
function AgentIndicator() {
  const agentActive = usePanelStore((s) => s.agentActive)
  const latest = usePanelStore((s) => s.activity[0])
  const { t } = useTranslation()
  if (!agentActive) return null
  return (
    <div className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-background/90 px-2.5 py-1 text-[11px] font-medium text-emerald-600 shadow-sm backdrop-blur dark:text-emerald-400">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
      </span>
      {t("browser.agentInBrowser")}{latest ? ` · ${latest.label}` : ""}
    </div>
  )
}

/** Feed of what the agent is doing — a small bar on the right edge of fullscreen
 *  that expands on hover (it does not cover the page content permanently) or
 *  stays open with the pin, like the conversation. */
function ActivityFeed({ pinned, onTogglePin }: { pinned: boolean; onTogglePin: () => void }) {
  const agentActive = usePanelStore((s) => s.agentActive)
  const activity = usePanelStore((s) => s.activity)
  const { t } = useTranslation()
  const { hovered, handleEnter, handleLeave } = useEdgeHover()
  const expanded = pinned || hovered

  // z-30: above the empty-state overlay (z-10, rendered later in the DOM),
  // which covered the bar on the start screen until the first search.
  return (
    <div
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className="absolute inset-y-0 right-0 z-30 flex items-center"
    >
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-l-xl border border-r-0 bg-background/95 shadow-lg backdrop-blur transition-all duration-300 ease-out",
          expanded ? "h-[min(55vh,440px)] w-72" : "h-12 w-9",
        )}
      >
        {/* Handle: always visible, indicates activity with a pulsing dot */}
        <Hint label={t("browser.browserActivity")}>
          <button
            type="button"
            onClick={onTogglePin}
            className="flex h-12 w-full shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          >
       
           <span className="relative flex items-center justify-center">
            <SparklesIcon className="size-4" />
            {agentActive && (
              <span className="absolute -right-1.5 -top-1.5 flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
              </span>
            )}
          </span>
        </button>
        </Hint>
        {expanded && (
          <div className="flex min-h-0 flex-1 animate-in flex-col fade-in-0 duration-200">
            <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
              <SparklesIcon className={cn("size-3.5", agentActive ? "text-emerald-500" : "text-muted-foreground")} />
              <Truncate text={agentActive ? t("browser.agentUsingBrowser") : t("browser.browserActivity")}>
                <span className="min-w-0 flex-1 truncate">
                  {agentActive ? t("browser.agentUsingBrowser") : t("browser.browserActivity")}
                </span>
              </Truncate>
              <FeedPinButton pinned={pinned} onToggle={onTogglePin} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {activity.length === 0 ? (
                <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                  {t("browser.emptyActivity")}
                </p>
              ) : (
                activity.map((entry, i) => (
                  <div
                    key={entry.id}
                    className={cn(
                      "flex items-start gap-2 rounded-md px-2 py-1.5 text-[11px]",
                      i === 0 ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", i === 0 ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                    <span className="min-w-0 flex-1">{entry.label}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function BrowserTab({
  initialUrl,
  persistKey,
  sessionId,
  onUrlChange,
}: {
  initialUrl?: string
  persistKey?: string
  /** Session that owns the tab — scope of the processes shown on the start screen. */
  sessionId?: string
  /** Notifies the current page URL (did-navigate) — keeps tab.url in sync. */
  onUrlChange?: (url: string) => void
}) {
  const fullscreen = usePanelStore((s) => s.fullscreen)
  const setFullscreen = usePanelStore((s) => s.setFullscreen)
  const [chatPinned, setChatPinned] = useState(false)
  const [activityPinned, setActivityPinned] = useState(false)
  const [composerPinned, setComposerPinned] = useState(false)

  // Closes the conversation feed and the composer when leaving fullscreen
  useEffect(() => {
    if (!fullscreen) {
      setChatPinned(false)
      setActivityPinned(false)
      setComposerPinned(false)
    }
  }, [fullscreen])

  // Esc leaves fullscreen
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fullscreen, setFullscreen])

  return (
    <WebPreview
      defaultUrl={initialUrl ?? ""}
      emptyExtra={(setUrl) => <RunningServers sessionId={sessionId} onSelect={setUrl} />}
      className={cn(
        "bg-sidebar",
        fullscreen
          ? FULLSCREEN_OVERLAY_CLASS
          : "h-full w-full rounded-none border-0",
      )}
    >
      <WebPreviewNavigation>
        <WebPreviewBackButton>
          <ArrowLeftIcon className="size-4" />
        </WebPreviewBackButton>
        <WebPreviewForwardButton>
          <ArrowRightIcon className="size-4" />
        </WebPreviewForwardButton>
        <WebPreviewReloadButton>
          <RefreshCcwIcon className="size-4" />
        </WebPreviewReloadButton>
        <WebPreviewUrl />
        <ViewportButton />
        <SelectModeButton />
        <WebPreviewOpenInNewTabButton>
          <ExternalLinkIcon className="size-4" />
        </WebPreviewOpenInNewTabButton>
        <FullscreenButton />
      </WebPreviewNavigation>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <AgentIndicator />
        {fullscreen && <ActivityFeed pinned={activityPinned} onTogglePin={() => setActivityPinned((v) => !v)} />}
        <PanelBrowserBody persistKey={persistKey} onUrlChange={onUrlChange} />
        {fullscreen && (
          <FullscreenChatFeed sessionId={sessionId} pinned={chatPinned} onTogglePin={() => setChatPinned((v) => !v)} />
        )}
        {fullscreen && (
          <FullscreenComposer
            fromBrowser
            sessionId={sessionId}
            pinned={composerPinned}
            onTogglePin={() => setComposerPinned((v) => !v)}
            onSent={() => setChatPinned(true)}
          />
        )}
      </div>
    </WebPreview>
  )
}
