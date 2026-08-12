import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  Loader2Icon,
  Maximize2Icon,
  MessagesSquareIcon,
  Minimize2Icon,
  MonitorIcon,
  MousePointerClickIcon,
  PinIcon,
  PinOffIcon,
  RefreshCcwIcon,
  SendIcon,
  SmartphoneIcon,
  SparklesIcon,
  SquareIcon,
  TabletIcon,
  X,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useWorkspace } from "@/lib/workspace-context"
import { cn } from "@/lib/utils"
import type { ChatMessage } from "@shared/chat"
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
import { Message, MessageContent } from "@/src/components/ai/message"
import { AskCard } from "@/src/components/ask-card"
import { AskCardBatch } from "@/src/components/ask-card-batch"
import { CodeAssistantMessage } from "@/src/components/messages/code-message"
import { ModelPicker } from "@/src/components/model-picker"
import { PermissionModePicker } from "@/src/components/permission-mode-picker"
import { visibleMessageText } from "@/src/lib/message-utils"
import { windowApi } from "@/src/lib/ipc"
import { reloadWebview } from "@/src/components/browser/webview-session"
import { usePanelStore, type Viewport } from "@/src/stores/panel-store"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"
import {
  useActiveSession,
  useSessionStatus,
  useSessionStore,
  type PendingAskUI,
} from "@/src/stores/session-store"

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
  reload(): void
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

/** Delays de hover das barras laterais da tela cheia — mesma convenção da
 *  sidebar do app (App.tsx: SIDEBAR_SHOW_DELAY=100 / SIDEBAR_HIDE_DELAY=300). */
const EDGE_SHOW_DELAY = 100
const EDGE_HIDE_DELAY = 300

/** Hover com delay simétrico para as barras laterais: abre rápido (100ms) ao
 *  encostar na borda e fecha com folga (300ms) ao sair — evita expandir ao
 *  cruzar a borda de passagem e colapsar ao mover o mouse para a página. */
function useEdgeHover() {
  const [hovered, setHovered] = useState(false)
  const showTimer = useRef<ReturnType<typeof setTimeout>>()
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const handleEnter = useCallback(() => {
    clearTimeout(hideTimer.current)
    showTimer.current = setTimeout(() => setHovered(true), EDGE_SHOW_DELAY)
  }, [])
  const handleLeave = useCallback(() => {
    clearTimeout(showTimer.current)
    hideTimer.current = setTimeout(() => setHovered(false), EDGE_HIDE_DELAY)
  }, [])
  useEffect(
    () => () => {
      clearTimeout(showTimer.current)
      clearTimeout(hideTimer.current)
    },
    [],
  )
  return { hovered, handleEnter, handleLeave }
}

function PanelBrowserBody({ persistKey }: { persistKey?: string }) {
  const { url, refreshKey } = useWebPreview()
  const selectMode = usePanelStore((s) => s.selectMode)
  const viewport = usePanelStore((s) => s.viewport)
  const initialSrcRef = useRef(url)
  // Estado do elemento: a montagem pode ser tardia (estado vazio → primeira URL
  // na barra) e o <webview> do pool é re-anexado a cada volta à aba — os efeitos
  // de ready/navegação reagem ao elemento, não a um ref fixo.
  const [webviewEl, setWebviewEl] = useState<WebviewElement | null>(null)

  // O <webview> vive no pool (webview-session.ts) — aqui só guardamos a
  // referência do elemento para os comandos (loadURL, execução de JS).
  const handleWebviewRef = useCallback((el: HTMLElement | null) => {
    setWebviewEl(el as WebviewElement | null)
  }, [])

  const handleConsoleMessage = useCallback((message: string) => {
    if (!message.startsWith(SELECT_PREFIX)) return
    try {
      usePanelStore.getState().addSelection(JSON.parse(message.slice(SELECT_PREFIX.length)))
    } catch {
      // payload malformado — ignora
    }
  }, [])

  // Ready-gate do <webview>: os métodos (getURL/loadURL/reload) só podem ser
  // chamados depois de o guest estar anexado ao DOM e ter emitido dom-ready —
  // antes disso o Electron lança "The WebView must be attached to the DOM and
  // the dom-ready event emitted before this method can be called". Enquanto não
  // está pronto, a URL pedida na barra fica pendente e é aplicada no primeiro
  // dom-ready (ou imediatamente, se o guest do pool já estiver pronto —
  // dom-ready não re-emite ao re-anexar o elemento).
  const readyRef = useRef(false)
  const pendingUrlRef = useRef<string | null>(null)

  // Gate declarado ANTES do efeito de navegação: a cada troca de elemento
  // (remount por key, re-anexo do pool) o readyRef é resetado para "não pronto"
  // antes de qualquer getURL/loadURL rodar no mesmo flush. Sem esse reset, o
  // readyRef do guest antigo (morto) faria o getURL() acertar um guest ainda
  // sem dom-ready → exceção não tratada em efeito → árvore inteira desmontada.
  useEffect(() => {
    if (!webviewEl) return
    readyRef.current = false // elemento novo/re-anexado — guest (ainda) não pronto
    const applyPendingUrl = () => {
      const pending = pendingUrlRef.current
      if (!pending) return
      pendingUrlRef.current = null
      try {
        if (webviewEl.getURL() !== pending) void webviewEl.loadURL(pending).catch(() => {})
      } catch {
        pendingUrlRef.current = pending // ainda não pronto — próximo dom-ready aplica
      }
    }
    const onReady = () => {
      readyRef.current = true
      applyPendingUrl()
      // Toggle de seleção feito antes do dom-ready não se perde
      try {
        void webviewEl.executeJavaScript(usePanelStore.getState().selectMode ? SELECT_ON : SELECT_OFF).catch(() => {})
      } catch {
        // guest ainda não pronto — o próximo dom-ready re-aplica
      }
    }
    webviewEl.addEventListener("dom-ready", onReady)
    try {
      webviewEl.getWebContentsId() // guest já pronto (pool) — dom-ready não re-emite
      onReady()
    } catch {
      // guest inicializando — o dom-ready chama onReady
    }
    return () => webviewEl.removeEventListener("dom-ready", onReady)
  }, [webviewEl])

  // Navegação controlada: mudanças na barra de URL viram loadURL (sem remount).
  // Roda DEPOIS do ready-gate — o readyRef já corresponde ao elemento atual.
  useEffect(() => {
    if (!webviewEl || !url) return
    if (!readyRef.current) {
      pendingUrlRef.current = url
      return
    }
    pendingUrlRef.current = null
    try {
      if (webviewEl.getURL() !== url) void webviewEl.loadURL(url).catch(() => {})
    } catch {
      // guest trocado entre o render e o efeito — volta para pendente
      readyRef.current = false
      pendingUrlRef.current = url
    }
  }, [url, webviewEl])

  // Modo seleção (clique vira badge no input): só roda com o guest pronto; se o
  // toggle vier antes, o onReady re-aplica com o estado atual do store.
  useEffect(() => {
    if (!webviewEl || !readyRef.current) return
    try {
      void webviewEl.executeJavaScript(selectMode ? SELECT_ON : SELECT_OFF).catch(() => {})
    } catch {
      // guest não pronto — o onReady re-aplica quando o dom-ready chegar
    }
  }, [selectMode, webviewEl])

  // Botão reload: recarrega no MESMO webview, sem recriar o guest (a página
  // não é destruída — apenas recarregada) — com pool via reloadWebview; sem
  // pool (BrowserTab do painel), reload direto no elemento.
  useEffect(() => {
    if (refreshKey <= 0) return
    if (persistKey) {
      reloadWebview(persistKey)
      return
    }
    if (webviewEl && readyRef.current) {
      try {
        webviewEl.reload()
      } catch {
        // webview não pronto — nada para recarregar ainda
      }
    }
  }, [refreshKey, persistKey, webviewEl])

  return (
    <WebPreviewBody
      src={initialSrcRef.current || undefined}
      onWebviewRef={handleWebviewRef}
      onConsoleMessage={handleConsoleMessage}
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

/** Feed do que o agente está fazendo — barinha na borda direita da tela cheia
 *  que expande no hover (não cobre o conteúdo da página permanentemente). */
function ActivityFeed() {
  const agentActive = usePanelStore((s) => s.agentActive)
  const activity = usePanelStore((s) => s.activity)
  const { t } = useTranslation()
  const { hovered, handleEnter, handleLeave } = useEdgeHover()

  return (
    <div
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className="absolute inset-y-0 right-0 z-10 flex items-center"
    >
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-l-xl border border-r-0 bg-background/95 shadow-lg backdrop-blur transition-all duration-300 ease-out",
          hovered ? "h-[min(55vh,440px)] w-72" : "h-12 w-9",
        )}
      >
        {/* Alça: sempre visível, indica atividade com um ponto pulsante */}
        <button
          type="button"
          title={t("browser.browserActivity")}
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
        {hovered && (
          <div className="flex min-h-0 flex-1 animate-in flex-col fade-in-0 duration-200">
            <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
              <SparklesIcon className={cn("size-3.5", agentActive ? "text-emerald-500" : "text-muted-foreground")} />
              {agentActive ? t("browser.agentUsingBrowser") : t("browser.browserActivity")}
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

/** Listas estáveis para os seletores do zustand (evitam re-render por referência nova). */
const NO_MSGS: ChatMessage[] = []
const NO_ASKS: PendingAskUI[] = []

/** Conversa da sessão de código ativa, ao vivo — painel lateral esquerdo
 *  colapsável da tela cheia. Mostra o streaming do agente em tempo real. */
function FullscreenChatFeed({ pinned, onTogglePin }: { pinned: boolean; onTogglePin: () => void }) {
  const { t } = useTranslation()
  const activeSession = useActiveSession("code")
  const sessionId = activeSession?.id
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] ?? NO_MSGS : NO_MSGS))
  const status = useSessionStatus(sessionId)
  const pendingAsks = useSessionStore((s) => (sessionId ? s.pendingAsks[sessionId] ?? NO_ASKS : NO_ASKS))
  const isBusy = status === "submitted" || status === "streaming"
  const { hovered, handleEnter, handleLeave } = useEdgeHover()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const expanded = pinned || hovered
  const hasAsks = pendingAsks.length > 0

  // Carrega o histórico da sessão (a tela cheia pode abrir antes do chat)
  useEffect(() => {
    if (sessionId) void useSessionStore.getState().ensureMessages(sessionId)
  }, [sessionId])

  // Mensagens renderizáveis (ignora resumos) — base para a janela virtualizada.
  const visibleMessages = useMemo(() => messages.filter((m) => !m.summary), [messages])

  // Virtualização "invertida": mostra a janela dos mais recentes e carrega os
  // antigos em chunks conforme o usuário rola para o topo (infinite scroll reverso).
  const MIN_WINDOW = 40
  const CHUNK = 40
  /** Pixels estimados por mensagem antiga ainda não renderizada (placeholder superior). */
  const OLDER_PX = 52
  const [startOffset, setStartOffset] = useState(0)
  const inited = useRef(false)
  const prevLength = useRef(visibleMessages.length)
  const prevExpanded = useRef(expanded)
  const rendered = visibleMessages.slice(startOffset)
  const hasOlder = startOffset > 0

  // No primeiro render, ancora no fim: mostra apenas os MIN_WINDOW mais recentes.
  useEffect(() => {
    if (inited.current) return
    inited.current = true
    setStartOffset(Math.max(0, visibleMessages.length - MIN_WINDOW))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // Ao abrir (hover/pin), posiciona no fim para exibir as mensagens mais recentes.
  useEffect(() => {
    if (expanded && !prevExpanded.current) scrollToBottom()
    prevExpanded.current = expanded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded])

  // Auto-scroll: novas mensagens / deltas do streaming / asks mudam a lista
  useEffect(() => {
    if (visibleMessages.length > prevLength.current) scrollToBottom()
    prevLength.current = visibleMessages.length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleMessages.length])

  // Carrega um chunk de mensagens antigas, preservando a posição de rolagem.
  const loadOlder = useCallback(() => {
    const el = scrollRef.current
    if (!el || startOffset <= 0) return
    const prevHeight = el.scrollHeight
    setStartOffset((s) => Math.max(0, s - CHUNK))
    requestAnimationFrame(() => {
      // Compensa a altura adicionada no topo para o viewport não "pular".
      if (el) el.scrollTop += el.scrollHeight - prevHeight
    })
  }, [startOffset, CHUNK])

  // Ao chegar perto do topo, expande a janela para os mais antigos.
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el || startOffset <= 0) return
    if (el.scrollTop < 60) loadOlder()
  }

  // Auto-expande (fixa) quando chega um pedido de permissão/pergunta novo,
  // para o usuário conseguir responder sem sair da tela cheia
  const prevAsks = useRef(0)
  useEffect(() => {
    if (pendingAsks.length > prevAsks.current && pendingAsks.length > 0 && !pinned) onTogglePin()
    prevAsks.current = pendingAsks.length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAsks.length])

  const lastAssistantId = useMemo(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant" && !m.summary)
    return last?.id
  }, [messages])

  return (
    <div
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className="absolute inset-y-0 left-0 z-10 flex items-center"
    >
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-r-xl border border-l-0 bg-background/95 shadow-lg backdrop-blur transition-all duration-300 ease-out",
          expanded ? "h-[min(70vh,540px)] w-96" : "h-12 w-9",
        )}
      >
        {/* Alça: sempre visível; ponto pulsante = agente ativo (verde) ou ask pendente (âmbar) */}
        <button
          type="button"
          onClick={onTogglePin}
          title={expanded ? t("browser.hideChatFeed") : t("browser.showChatFeed")}
          className="flex h-12 w-full shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="relative flex items-center justify-center">
            <MessagesSquareIcon className="size-4" />
            {(isBusy || hasAsks) && (
              <span className="absolute -right-1.5 -top-1.5 flex size-2">
                <span
                  className={cn(
                    "absolute inline-flex size-full animate-ping rounded-full opacity-75",
                    hasAsks ? "bg-amber-500" : "bg-emerald-500",
                  )}
                />
                <span
                  className={cn("relative inline-flex size-2 rounded-full", hasAsks ? "bg-amber-500" : "bg-emerald-500")}
                />
              </span>
            )}
          </span>
        </button>
        {expanded && (
          <div className="flex min-h-0 flex-1 animate-in flex-col fade-in-0 duration-200">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <MessagesSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {activeSession?.title ?? t("browser.chatFeed")}
              </span>
              {isBusy && (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-500">
                  <span className="relative flex size-1.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                  </span>
                  {t("chat.code.analyzing")}
                </span>
              )}
              <button
                type="button"
                onClick={onTogglePin}
                title={pinned ? t("browser.unpinFeed") : t("browser.pinFeed")}
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground",
                  pinned && "text-primary hover:text-primary",
                )}
              >
                {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
              </button>
            </div>
            <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto p-3">
              {messages.length === 0 && !hasAsks ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t("browser.emptyConversation")}</p>
              ) : (
                <div className="flex flex-col">
                  {/* Placeholder de mensagens antigas ainda não carregadas —
                      ao rolar para o topo, `loadOlder` as materializa em chunks. */}
                  {hasOlder && (
                    <div
                      aria-hidden
                      className="pointer-events-none flex w-full items-center justify-center py-2 text-[10px] uppercase tracking-wide text-muted-foreground/60"
                      style={{ height: startOffset * OLDER_PX }}
                    >
                      {t("browser.loadingOlder")}
                    </div>
                  )}
                  <div className="flex flex-col gap-3">
                  {rendered.map((msg) => {
                    if (msg.summary) return null
                    if (msg.role === "user") {
                      return (
                        <Message from="user" key={msg.id} data-msg-id={msg.id}>
                          <MessageContent>
                            <p className="whitespace-pre-wrap text-sm">{visibleMessageText(msg)}</p>
                          </MessageContent>
                        </Message>
                      )
                    }
                    const isLast = msg.id === lastAssistantId
                    return (
                      <Message from="assistant" key={msg.id} data-msg-id={msg.id}>
                        <MessageContent>
                          <CodeAssistantMessage message={msg} sessionId={sessionId} isLast={isLast} isBusy={isBusy} />
                        </MessageContent>
                      </Message>
                    )
                  })}
                  {/* Pedidos de permissão de tools / perguntas aguardando resposta —
                      mesmo comportamento do chat de código (chat-view). */}
                  {hasAsks && (
                    <div className="flex flex-col gap-2 border-t pt-2">
                      {pendingAsks
                        .filter((a) => !a.batchId)
                        .map((ask) => (
                          <AskCard key={ask.requestId} ask={ask} sessionId={sessionId} />
                        ))}
                      {[...new Set(pendingAsks.map((a) => a.batchId).filter(Boolean))].map((batchId) => (
                        <AskCardBatch key={batchId} items={pendingAsks.filter((a) => a.batchId === batchId)} />
                      ))}
                    </div>
                  )}
                </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Composer para pedir algo à IA sem sair da tela cheia (envia ao chat de código). */
function FullscreenComposer({ onSent }: { onSent?: () => void }) {
  const { folders } = useWorkspace()
  const activeSession = useActiveSession("code")
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)
  const permissionMode = usePermissionPrefs((s) => s.mode)
  const status = useSessionStatus(activeSession?.id)
  const isBusy = status === "submitted" || status === "streaming"
  const { t } = useTranslation()
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const selections = usePanelStore((s) => s.selections)
  const removeSelection = usePanelStore((s) => s.removeSelection)

  const disabled = folders.length === 0
  const submit = async () => {
    const base = text.trim()
    if (!base || disabled || sending) return
    setSending(true)
    const [directory, ...extraDirectories] = folders
    // Elementos selecionados no browser seguem na mensagem, como no input principal
    let value = base
    if (selections.length > 0) {
      value += `\n\n${selections
        .map(
          (sel) =>
            `[Elemento selecionado no browser do painel — <${sel.tag}> em ${sel.url}]\nselector: ${sel.selector}\ntexto: ${sel.text || "(sem texto)"}\nhtml: ${sel.html}`,
        )
        .join("\n\n")}`
    }
    try {
      await sendMessage("code", value, {
        options: { permissionMode, brain: true },
        directory,
        extraDirectories,
        sessionId: activeSession?.id,
      })
      if (selections.length > 0) usePanelStore.getState().clearSelections()
      setText("")
      // Abre o feed de conversa para o usuário acompanhar a resposta
      onSent?.()
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="absolute bottom-4 left-1/2 z-20 w-full max-w-2xl -translate-x-1/2 px-4">
      <div className="rounded-xl border-2 border-sidebar-border bg-background/95 shadow-lg backdrop-blur">
        <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1.5">
          <ModelPicker sessionId={activeSession?.id} />
          <PermissionModePicker />
        </div>
        {selections.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
            {selections.map((sel) => (
              <span
                key={sel.id}
                title={`${sel.selector}\n"${sel.text}"`}
                className="flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400"
              >
                <MousePointerClickIcon className="size-3" />
                {"<"}{sel.tag}{">"} {sel.text ? `"${sel.text.slice(0, 24)}${sel.text.length > 24 ? "…" : ""}"` : t("codeInput.selected")}
                <button
                  type="button"
                  onClick={() => removeSelection(sel.id)}
                  className="ml-0.5 rounded-sm hover:bg-emerald-500/20"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 p-1.5">
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
          {isBusy ? (
            <button
              type="button"
              onClick={() => activeSession?.id && stopStreaming(activeSession.id)}
              title={t("send.stop")}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90"
            >
              <SquareIcon className="size-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={disabled || sending || !text.trim()}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40"
            >
              {sending ? <Loader2Icon className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function BrowserTab({ initialUrl, persistKey }: { initialUrl?: string; persistKey?: string }) {
  const fullscreen = usePanelStore((s) => s.fullscreen)
  const setFullscreen = usePanelStore((s) => s.setFullscreen)
  const [chatPinned, setChatPinned] = useState(false)

  /**
   * No macOS a janela usa titleBarStyle 'hiddenInset': as bolinhas de fechar/
   * minimizar/redimensionar ficam sobrepostas ao topo do conteúdo. Em tela cheia
   * o overlay cobre a janela inteira e esbarra nesses controles; compensamos
   * deixando a TitleBar (h-8) visível e iniciando o overlay logo abaixo dela,
   * mantendo o header padrão do app abaixo do header nativo da janela.
   */
  const isMac = windowApi.platform === "darwin"

  // Fecha o feed de conversa ao sair da tela cheia
  useEffect(() => {
    if (!fullscreen) setChatPinned(false)
  }, [fullscreen])

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
          ? cn("fixed inset-0 z-[70] h-auto w-auto rounded-none border-0", isMac && "top-8")
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
        <PanelBrowserBody persistKey={persistKey} />
        {fullscreen && <FullscreenChatFeed pinned={chatPinned} onTogglePin={() => setChatPinned((v) => !v)} />}
        {fullscreen && <FullscreenComposer onSent={() => setChatPinned(true)} />}
      </div>
    </WebPreview>
  )
}
