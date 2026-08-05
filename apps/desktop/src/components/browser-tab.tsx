import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  Loader2Icon,
  Maximize2Icon,
  Minimize2Icon,
  MonitorIcon,
  MousePointerClickIcon,
  RefreshCcwIcon,
  SendIcon,
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
import { useWorkspace } from "@/lib/workspace-context"
import { cn } from "@/lib/utils"
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
import { panelApi } from "@/src/lib/ipc"
import { usePanelStore, type Viewport } from "@/src/stores/panel-store"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"
import { useActiveSession, useSessionStore } from "@/src/stores/session-store"

/**
 * Aba Browser do painel direito, controlável pelo agente (tools panel_*):
 * - registra o webContents do <webview> no main (panel:register)
 * - navegação da barra de URL é controlada (loadURL), sem remount do webview
 * - modo seleção: clique em um elemento vira badge/anexo no input do code mode
 * - viewport (responsividade), tela cheia com feed de atividade e composer p/ IA
 */

interface WebviewElement extends HTMLElement {
  getWebContentsId(): number
  getURL(): string
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string): Promise<unknown>
  isLoading(): boolean
}

const SELECT_PREFIX = "__ORBIT_SELECT__"

const SELECT_ON = `(() => {
  if (window.__orbitSelectCleanup) window.__orbitSelectCleanup()
  let last = null
  const restore = () => { if (last) { last.style.outline = last.__orbitOutline || ''; last = null } }
  const over = (e) => {
    restore()
    last = e.target
    last.__orbitOutline = last.style.outline
    last.style.outline = '2px solid #22c55e'
  }
  const cssPath = (el) => {
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 5) {
      if (node.id) { parts.unshift('#' + node.id); break }
      let part = node.tagName.toLowerCase()
      const cls = [...node.classList].slice(0, 2).join('.')
      if (cls) part += '.' + cls
      const parent = node.parentElement
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === node.tagName)
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      node = node.parentElement
    }
    return parts.join(' > ')
  }
  const click = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.target
    console.log('${SELECT_PREFIX}' + JSON.stringify({
      tag: el.tagName.toLowerCase(),
      selector: cssPath(el),
      text: (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 200),
      html: el.outerHTML.slice(0, 1500),
      url: location.href,
    }))
    window.__orbitSelectCleanup()
  }
  document.addEventListener('mouseover', over, true)
  document.addEventListener('click', click, true)
  window.__orbitSelectCleanup = () => {
    document.removeEventListener('mouseover', over, true)
    document.removeEventListener('click', click, true)
    restore()
    window.__orbitSelectCleanup = null
  }
})()`

const SELECT_OFF = `window.__orbitSelectCleanup && window.__orbitSelectCleanup()`

const VIEWPORT_PRESETS: { icon: typeof MonitorIcon; labelKey: string; viewport: Viewport | null }[] = [
  { icon: MonitorIcon, labelKey: "browser.viewportFit", viewport: null },
  { icon: SmartphoneIcon, labelKey: "browser.viewportMobile", viewport: { width: 390, height: 844, label: "mobile" } },
  { icon: TabletIcon, labelKey: "browser.viewportTablet", viewport: { width: 834, height: 1112, label: "tablet" } },
  { icon: MonitorIcon, labelKey: "browser.viewportDesktop", viewport: { width: 1440, height: 900, label: "desktop" } },
]

function PanelBrowserBody() {
  const { url, setUrl } = useWebPreview()
  const selectMode = usePanelStore((s) => s.selectMode)
  const viewport = usePanelStore((s) => s.viewport)
  const webviewRef = useRef<WebviewElement | null>(null)
  const readyRef = useRef(false)
  const initialSrcRef = useRef(url)
  const setUrlRef = useRef(setUrl)
  setUrlRef.current = setUrl

  const handleWebviewRef = useCallback((el: HTMLElement | null) => {
    const webview = el as WebviewElement | null
    if (!webview) {
      readyRef.current = false
      webviewRef.current = null
      panelApi.register(null)
      return
    }
    webviewRef.current = webview
    webview.addEventListener("dom-ready", () => {
      readyRef.current = true
      panelApi.register(webview.getWebContentsId())
    })
    const syncUrl = (e: Event) => {
      const navUrl = (e as Event & { url?: string }).url
      if (navUrl && navUrl !== "about:blank") setUrlRef.current(navUrl)
    }
    webview.addEventListener("did-navigate", syncUrl)
    webview.addEventListener("did-navigate-in-page", syncUrl)
    webview.addEventListener("console-message", (e) => {
      const message = (e as Event & { message?: string }).message
      if (!message?.startsWith(SELECT_PREFIX)) return
      try {
        usePanelStore.getState().addSelection(JSON.parse(message.slice(SELECT_PREFIX.length)))
      } catch {
        // payload malformado — ignora
      }
    })
  }, [])

  // Navegação controlada: mudanças na barra de URL viram loadURL (sem remount)
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || !readyRef.current || !url) return
    if (webview.getURL() !== url) void webview.loadURL(url).catch(() => {})
  }, [url])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || !readyRef.current) return
    void webview.executeJavaScript(selectMode ? SELECT_ON : SELECT_OFF).catch(() => {})
  }, [selectMode])

  return (
    <WebPreviewBody
      src={initialSrcRef.current || undefined}
      onWebviewRef={handleWebviewRef}
      viewport={viewport}
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

/** Indicador de que o agente está dirigindo o browser (badge no modo lateral). */
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

/** Feed do que o agente está fazendo — mostrado na tela cheia. */
function ActivityFeed() {
  const agentActive = usePanelStore((s) => s.agentActive)
  const activity = usePanelStore((s) => s.activity)
  const { t } = useTranslation()
  return (
    <div className="absolute right-3 top-3 z-10 flex max-h-[45vh] w-72 flex-col overflow-hidden rounded-xl border bg-background/95 shadow-lg backdrop-blur">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
        <SparklesIcon className={cn("size-3.5", agentActive ? "text-emerald-500" : "text-muted-foreground")} />
        {agentActive ? t("browser.agentUsingBrowser") : t("browser.browserActivity")}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
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
  )
}

/** Composer para pedir algo à IA sem sair da tela cheia (envia ao chat de código). */
function FullscreenComposer() {
  const { folders } = useWorkspace()
  const activeSession = useActiveSession("code")
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const permissionMode = usePermissionPrefs((s) => s.mode)
  const { t } = useTranslation()
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)

  const disabled = folders.length === 0
  const submit = async () => {
    const value = text.trim()
    if (!value || disabled || sending) return
    setSending(true)
    const [directory, ...extraDirectories] = folders
    try {
      await sendMessage("code", value, {
        options: { permissionMode, brain: true },
        directory,
        extraDirectories,
        sessionId: activeSession?.id,
      })
      setText("")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="absolute bottom-4 left-1/2 z-10 w-full max-w-xl -translate-x-1/2 px-4">
      <div className="flex items-end gap-2 rounded-xl border-2 border-sidebar-border bg-background/95 p-1.5 shadow-lg backdrop-blur">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          rows={1}
          placeholder={disabled ? t("browser.composerPlaceholderNoFolder") : t("browser.composerPlaceholder")}
          disabled={disabled}
          className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={disabled || sending || !text.trim()}
          className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40"
        >
          {sending ? <Loader2Icon className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
        </button>
      </div>
    </div>
  )
}

export function BrowserTab({ initialUrl }: { initialUrl?: string }) {
  const fullscreen = usePanelStore((s) => s.fullscreen)
  const setFullscreen = usePanelStore((s) => s.setFullscreen)

  // Esc sai da tela cheia
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
      className={cn(
        "bg-sidebar",
        fullscreen
          ? "fixed inset-0 z-[70] h-auto w-auto rounded-none border-0"
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
        {fullscreen && <ActivityFeed />}
        <PanelBrowserBody />
        {fullscreen && <FullscreenComposer />}
      </div>
    </WebPreview>
  )
}
