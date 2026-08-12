import { useTranslation } from "react-i18next"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  Maximize2Icon,
  MousePointerClickIcon,
  RefreshCcwIcon,
  Globe,
} from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import { createContext, useContext, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatTime } from "@/src/lib/format"
import { mountWebview, unmountWebview } from "@/src/components/browser/webview-session"

export interface WebPreviewContextValue {
  url: string
  setUrl: (url: string) => void
  /** Atualiza a URL atual sem empurrar no histórico (usado quando o conteúdo
   *  do webview navega por fora — ex.: agente dirigindo o browser). */
  syncUrl: (url: string) => void
  consoleOpen: boolean
  setConsoleOpen: (open: boolean) => void
  goBack: () => void
  goForward: () => void
  reload: () => void
  canGoBack: boolean
  canGoForward: boolean
  refreshKey: number
}

const WebPreviewContext = createContext<WebPreviewContextValue | null>(null)

export const useWebPreview = () => {
  const context = useContext(WebPreviewContext)
  if (!context) {
    throw new Error("WebPreview components must be used within a WebPreview")
  }
  return context
}

export type WebPreviewProps = ComponentProps<"div"> & {
  defaultUrl?: string
  onUrlChange?: (url: string) => void
}

function formatBrowserUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ""
  
  if (/^(https?:\/\/)/i.test(trimmed)) {
    return trimmed
  }
  
  const hasSpaces = /\s/.test(trimmed)
  const hasDot = trimmed.includes(".")
  const isLocalhost = trimmed.startsWith("localhost:") || trimmed === "localhost"
  const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(trimmed)
  
  if (hasSpaces || (!hasDot && !isLocalhost && !isIp)) {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
  }
  
  return `https://${trimmed}`
}

export const WebPreview = ({
  className,
  children,
  defaultUrl = "",
  onUrlChange,
  ...props
}: WebPreviewProps) => {
  const [history, setHistory] = useState<string[]>([defaultUrl])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  const url = history[currentIndex] || ""

  const handleUrlChange = (newUrl: string) => {
    const formattedUrl = formatBrowserUrl(newUrl)
    const newHistory = history.slice(0, currentIndex + 1)
    newHistory.push(formattedUrl)
    setHistory(newHistory)
    setCurrentIndex(newHistory.length - 1)
    onUrlChange?.(formattedUrl)
  }

  const goBack = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1)
      onUrlChange?.(history[currentIndex - 1])
    }
  }

  const goForward = () => {
    if (currentIndex < history.length - 1) {
      setCurrentIndex(currentIndex + 1)
      onUrlChange?.(history[currentIndex + 1])
    }
  }

  const syncUrl = (newUrl: string) => {
    setHistory((prev) => {
      if (prev[currentIndex] === newUrl) return prev
      const next = [...prev]
      next[currentIndex] = newUrl
      return next
    })
  }

  const reload = () => {
    setRefreshKey(prev => prev + 1)
  }

  const contextValue: WebPreviewContextValue = {
    url,
    setUrl: handleUrlChange,
    syncUrl,
    consoleOpen,
    setConsoleOpen,
    goBack,
    goForward,
    reload,
    canGoBack: currentIndex > 0,
    canGoForward: currentIndex < history.length - 1,
    refreshKey,
  }

  return (
    <WebPreviewContext.Provider value={contextValue}>
      <div
        className={cn("flex size-full flex-col rounded-lg border bg-card", className)}
        {...props}
      >
        {children}
      </div>
    </WebPreviewContext.Provider>
  )
}

export type WebPreviewNavigationProps = ComponentProps<"div">

export const WebPreviewNavigation = ({
  className,
  children,
  ...props
}: WebPreviewNavigationProps) => (
  <div className={cn("flex items-center gap-1 border-b p-2", className)} {...props}>
    {children}
  </div>
)

export type WebPreviewNavigationButtonProps = ComponentProps<typeof Button> & {
  tooltip?: string
}

export const WebPreviewNavigationButton = ({
  onClick,
  disabled,
  tooltip,
  children,
  ...props
}: WebPreviewNavigationButtonProps) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger render={<Button className="h-8 w-8 p-0 hover:text-foreground" disabled={disabled} onClick={onClick} size="sm" variant="ghost" {...props} />}>{children}</TooltipTrigger>
      <TooltipContent>
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
)

export const WebPreviewBackButton = (props: Omit<WebPreviewNavigationButtonProps, "onClick" | "disabled" | "tooltip">) => {
  const { goBack, canGoBack } = useWebPreview()
  const { t } = useTranslation()
  return <WebPreviewNavigationButton onClick={goBack} disabled={!canGoBack} tooltip={t("webPreview.back")} {...props} />
}

export const WebPreviewForwardButton = (props: Omit<WebPreviewNavigationButtonProps, "onClick" | "disabled" | "tooltip">) => {
  const { goForward, canGoForward } = useWebPreview()
  const { t } = useTranslation()
  return <WebPreviewNavigationButton onClick={goForward} disabled={!canGoForward} tooltip={t("webPreview.forward")} {...props} />
}

export const WebPreviewReloadButton = (props: Omit<WebPreviewNavigationButtonProps, "onClick" | "tooltip">) => {
  const { reload } = useWebPreview()
  const { t } = useTranslation()
  return <WebPreviewNavigationButton onClick={reload} tooltip={t("webPreview.reload")} {...props} />
}

export const WebPreviewOpenInNewTabButton = (props: Omit<WebPreviewNavigationButtonProps, "onClick" | "tooltip">) => {
  const { url } = useWebPreview()
  const { t } = useTranslation()
  return (
    <WebPreviewNavigationButton 
      onClick={() => {
        if (url) window.open(url, "_blank")
      }} 
      disabled={!url}
      tooltip={t("webPreview.openInNewTab")} 
      {...props} 
    />
  )
}

export type WebPreviewUrlProps = ComponentProps<typeof Input>

export const WebPreviewUrl = ({ value, onChange, onKeyDown, ...props }: WebPreviewUrlProps) => {
  const { url, setUrl } = useWebPreview()
  const { t } = useTranslation()
  const [inputValue, setInputValue] = useState(url)

  // Sync input value with context URL when it changes externally
  useEffect(() => {
    setInputValue(url)
  }, [url])

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(event.target.value)
    onChange?.(event)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      const target = event.target as HTMLInputElement
      setUrl(target.value)
    }
    onKeyDown?.(event)
  }

  return (
    <Input
      className="h-8 flex-1 text-sm"
      onChange={onChange ?? handleChange}
      onKeyDown={handleKeyDown}
      placeholder={t("webPreview.enterUrl")}
      value={value ?? inputValue}
      {...props}
    />
  )
}

export type WebPreviewBodyProps = ComponentProps<"iframe"> & {
  loading?: ReactNode
  /** Recebe o elemento <webview> montado (controle programático do painel) */
  onWebviewRef?: (el: HTMLElement | null) => void
  /** Dimensões fixas do viewport (responsividade). Ausente = preenche o container. */
  viewport?: { width: number; height: number } | null
  /** Chave de persistência do <webview> no pool (sessionId:tabId). Quando
   *  presente, o webview sobrevive a desmontagens do componente (troca de
   *  chat/aba) e a página continua viva — e o agente pode navegar em background. */
  persistKey?: string
  /** Mensagens de console do webview persistido (ex.: payloads do modo seleção). */
  onConsoleMessage?: (message: string) => void
}

export const WebPreviewBody = ({
  className,
  loading,
  src,
  onWebviewRef,
  viewport,
  persistKey,
  onConsoleMessage,
  ...props
}: WebPreviewBodyProps) => {
  const { url, setUrl, syncUrl } = useWebPreview()
  const { t } = useTranslation()
  const [localUrl, setLocalUrl] = useState("")
  const containerRef = useRef<HTMLDivElement | null>(null)
  const syncUrlRef = useRef(syncUrl)
  syncUrlRef.current = syncUrl
  const onWebviewRefRef = useRef(onWebviewRef)
  onWebviewRefRef.current = onWebviewRef
  const onConsoleMessageRef = useRef(onConsoleMessage)
  onConsoleMessageRef.current = onConsoleMessage

  // Webview persistente (pool): o elemento <webview> sobrevive ao unmount do
  // componente — voltar a esta aba reexibe a página exatamente onde estava.
  useEffect(() => {
    if (!persistKey) return
    const container = containerRef.current
    if (!container) return
    const el = mountWebview(
      persistKey,
      container,
      src ?? url ?? undefined,
      (navUrl) => syncUrlRef.current(navUrl),
      (message) => onConsoleMessageRef.current?.(message),
    )
    onWebviewRefRef.current?.(el)
    // Aba já tinha página carregada (de um ciclo anterior)? Espelha na barra.
    try {
      const currentUrl = el.getURL()
      if (currentUrl && currentUrl !== "about:blank") syncUrlRef.current(currentUrl)
    } catch {
      // guest ainda não pronto — o próximo did-navigate sincroniza
    }
    return () => {
      onWebviewRefRef.current?.(null)
      unmountWebview(persistKey)
    }
    // monta/desmonta conforme a chave: a navegação é feita por loadURL (efeito
    // do PanelBrowserBody) ou pelo agente — nunca recria o webview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistKey])

  const empty = !url && !src

  if (persistKey) {
    // Com persistência, o container SEMPRE existe (o efeito acima anexa o
    // webview mesmo sem URL inicial) — o estado vazio vira um overlay, e a
    // primeira URL digitada navega no MESMO webview persistido.
    return (
      <div
        className={cn(
          "relative flex-1 overflow-auto",
          viewport && "flex items-start justify-center bg-muted/40 p-3",
        )}
      >
        {/* O <webview> vive no pool (webview-session.ts) e é movido pra cá */}
        <div
          ref={containerRef}
          className={cn("bg-white", viewport ? "shrink-0 rounded-md border shadow-sm" : "size-full", className)}
          style={viewport ? { width: viewport.width, height: viewport.height } : undefined}
          {...(props as any)}
        />
        {empty && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-sidebar p-6 text-center text-muted-foreground">
            <div className="rounded-full bg-muted p-4">
              <Globe className="size-10 text-muted-foreground/80" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-foreground">{t("webPreview.emptyTitle")}</h3>
              <p className="max-w-[280px] text-xs text-muted-foreground">{t("webPreview.emptyHint")}</p>
            </div>
            <div className="mt-2 flex w-full max-w-xs items-center space-x-2">
              <Input
                placeholder={t("webPreview.urlExample")}
                value={localUrl}
                onChange={(e) => setLocalUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setUrl(localUrl)
                  }
                }}
                className="h-8 text-xs"
              />
              <Button onClick={() => setUrl(localUrl)} size="sm" className="h-8 px-3 text-xs">
                {t("webPreview.go")}
              </Button>
            </div>
          </div>
        )}
        {loading}
      </div>
    )
  }

  if (empty) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-transparent p-6 text-center text-muted-foreground h-full">
        <div className="rounded-full bg-muted p-4">
          <Globe className="size-10 text-muted-foreground/80" />
        </div>
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-foreground">{t("webPreview.emptyTitle")}</h3>
          <p className="max-w-[280px] text-xs text-muted-foreground">{t("webPreview.emptyHint")}</p>
        </div>
        <div className="mt-2 flex w-full max-w-xs items-center space-x-2">
          <Input 
            placeholder={t("webPreview.urlExample")} 
            value={localUrl}
            onChange={(e) => setLocalUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setUrl(localUrl)
              }
            }}
            className="h-8 text-xs"
          />
          <Button onClick={() => setUrl(localUrl)} size="sm" className="h-8 px-3 text-xs">
            {t("webPreview.go")}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "flex-1 overflow-auto",
        viewport && "flex items-start justify-center bg-muted/40 p-3",
      )}
    >
      {/* @ts-ignore webview is an electron specific tag */}
      <webview
        ref={onWebviewRef as never}
        className={cn("bg-white", viewport ? "shrink-0 rounded-md border shadow-sm" : "size-full", className)}
        style={viewport ? { width: viewport.width, height: viewport.height } : undefined}
        src={(src ?? url) || undefined}
        title={t("webPreview.previewTitle")}
        {...(props as any)}
      />
      {loading}
    </div>
  )
}

export type WebPreviewConsoleProps = ComponentProps<typeof Collapsible> & {
  logs?: Array<{
    level: "log" | "warn" | "error"
    message: string
    timestamp: Date
  }>
}

export const WebPreviewConsole = ({
  className,
  logs = [],
  children,
  ...props
}: WebPreviewConsoleProps) => {
  const { consoleOpen, setConsoleOpen } = useWebPreview()
  const { t, i18n } = useTranslation()

  return (
    <Collapsible
      className={cn("border-t bg-muted/50 font-mono text-sm", className)}
      onOpenChange={setConsoleOpen}
      open={consoleOpen}
      {...props}
    >
      <CollapsibleTrigger render={<Button className="flex w-full items-center justify-between p-4 text-left font-medium hover:bg-muted/50" variant="ghost" />}>{t("webPreview.console")}
                    <ChevronDownIcon
                      className={cn("h-4 w-4 transition-transform duration-200", consoleOpen && "rotate-180")}
                    /></CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "px-4 pb-4",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        )}
      >
        <div className="max-h-48 space-y-1 overflow-y-auto">
          {logs.length === 0 ? (
            <p className="text-muted-foreground">{t("webPreview.noConsoleOutput")}</p>
          ) : (
            logs.map((log, index) => (
              <div
                className={cn(
                  "text-xs",
                  log.level === "error" && "text-destructive",
                  log.level === "warn" && "text-yellow-600",
                  log.level === "log" && "text-foreground",
                )}
                key={`${log.timestamp.getTime()}-${index}`}
              >
                <span className="text-muted-foreground">{formatTime(log.timestamp.getTime(), i18n.language)}</span>{" "}
                {log.message}
              </div>
            ))
          )}
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

const exampleLogs = [
  {
    level: "log" as const,
    message: "Page loaded successfully",
    timestamp: new Date(Date.now() - 10_000),
  },
  {
    level: "warn" as const,
    message: "Deprecated API usage detected",
    timestamp: new Date(Date.now() - 5000),
  },
  { level: "error" as const, message: "Failed to load resource", timestamp: new Date() },
]

/** Demo component for preview */
export default function WebPreviewDemo() {
  return (
    <WebPreview defaultUrl="/" style={{ height: "400px" }}>
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
        <WebPreviewNavigationButton tooltip="Select">
          <MousePointerClickIcon className="size-4" />
        </WebPreviewNavigationButton>
        <WebPreviewOpenInNewTabButton>
          <ExternalLinkIcon className="size-4" />
        </WebPreviewOpenInNewTabButton>
        <WebPreviewNavigationButton tooltip="Maximize">
          <Maximize2Icon className="size-4" />
        </WebPreviewNavigationButton>
      </WebPreviewNavigation>
      <WebPreviewBody src="https://example.com" />
      <WebPreviewConsole logs={exampleLogs} />
    </WebPreview>
  )
}
