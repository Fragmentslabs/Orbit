import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  Maximize2Icon,
  MessagesSquareIcon,
  Minimize2Icon,
  MonitorIcon,
  MousePointerClickIcon,
  PinIcon,
  PinOffIcon,
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
import type { ChatMessage, FilePart, SendMessageOptions } from "@shared/chat"
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
import { CodeInput } from "@/src/components/code-input"
import { visibleMessageText } from "@/src/lib/message-utils"
import { windowApi } from "@/src/lib/ipc"
import {
  applySelectMode,
  navigateWebview,
  reloadWebview,
} from "@/src/components/browser/webview-session"
import { usePanelStore, type Viewport } from "@/src/stores/panel-store"
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

/**
 * Corpo da aba: só orquestra intenções (navegar, recarregar, ligar seleção).
 * Quem fala com o `<webview>` é o pool (webview-session.ts) — nenhuma API do
 * guest é chamada daqui, porque o guest é recriado a cada re-parent e uma
 * chamada fora de hora lança e derruba a árvore React inteira.
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

  // Navegação controlada: a barra de URL pede, o pool aplica quando der.
  useEffect(() => {
    if (!persistKey || !url) return
    navigateWebview(persistKey, url)
  }, [url, persistKey])

  // Modo seleção — o pool também re-injeta a cada guest novo (dom-ready).
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
  const isBusy = status === "submitted" || status === "streaming" || status === "cancelling"
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

/**
 * Composer da tela cheia: é o MESMO input do chat de código (CodeInput) — com
 * modelo, modo de permissão, toggles, comandos "/", anexos e os badges de
 * elemento selecionado. Antes era um textarea próprio, que ia ficando para trás
 * a cada recurso novo do input principal.
 */
function FullscreenComposer({ onSent }: { onSent?: () => void }) {
  const activeSession = useActiveSession("code")
  const sessionId = activeSession?.id
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)
  const status = useSessionStatus(sessionId)
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] ?? NO_MSGS : NO_MSGS))

  const handleSubmit = useCallback(
    (
      text: string,
      options: SendMessageOptions,
      directory: string,
      extraDirectories: string[],
      files?: FilePart[],
    ) => {
      void sendMessage("code", text, { options, directory, extraDirectories, sessionId, files })
      // Abre o feed de conversa para o usuário acompanhar a resposta
      onSent?.()
    },
    [sendMessage, sessionId, onSent],
  )

  const handleStop = useCallback(() => {
    if (sessionId) stopStreaming(sessionId)
  }, [sessionId, stopStreaming])

  return (
    <div className="absolute bottom-4 left-1/2 z-20 w-full max-w-2xl -translate-x-1/2 px-4">
      {/* Fundo opaco próprio: o InputGroup do CodeInput é semitransparente e,
          sobre a página em tela cheia, ficaria ilegível. Sem borda aqui — a do
          input já existe e duas viram moldura dupla. */}
      <div className="rounded-xl bg-background/95 px-3 pt-3 shadow-lg backdrop-blur">
        <CodeInput
          onSubmit={handleSubmit}
          status={status}
          onStop={handleStop}
          hasMessages={messages.length > 0}
          sessionId={sessionId}
        />
      </div>
    </div>
  )
}

export function BrowserTab({
  initialUrl,
  persistKey,
  onUrlChange,
}: {
  initialUrl?: string
  persistKey?: string
  /** Notifica a URL atual da página (did-navigate) — mantém tab.url sincronizado. */
  onUrlChange?: (url: string) => void
}) {
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
        <PanelBrowserBody persistKey={persistKey} onUrlChange={onUrlChange} />
        {fullscreen && <FullscreenChatFeed pinned={chatPinned} onTogglePin={() => setChatPinned((v) => !v)} />}
        {fullscreen && <FullscreenComposer onSent={() => setChatPinned(true)} />}
      </div>
    </WebPreview>
  )
}
