import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, Loader2Icon, MessagesSquareIcon, PinIcon, PinOffIcon, XIcon, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ChatMessage, FilePart, SendMessageOptions, ToolPart } from "@shared/chat"
import { Message, MessageContent } from "@/src/components/ai/message"
import { AskCard } from "@/src/components/ask-card"
import { AskCardBatch } from "@/src/components/ask-card-batch"
import { CodeInput } from "@/src/components/code-input"
import { CodeAssistantMessage } from "@/src/components/messages/code-message"
import { UserMessageText } from "@/src/components/messages/shared"
import { visibleMessageText } from "@/src/lib/message-utils"
import { useActiveSession, useSessionStatus, useSessionStore, type PendingAskUI } from "@/src/stores/session-store"

/**
 * Peças compartilhadas das telas cheias (browser, Motion e Design): o composer
 * que só aparece no hover da borda inferior e as sidebars flutuantes que
 * copiam a aparência da sidebar padrão do app.
 */

/** Delays de hover das barras da tela cheia — mesma convenção da sidebar do
 *  app (App.tsx: SIDEBAR_SHOW_DELAY=100 / SIDEBAR_HIDE_DELAY=300). */
const EDGE_SHOW_DELAY = 100
const EDGE_HIDE_DELAY = 300

/** Hover com delay simétrico: abre rápido (100ms) ao encostar na borda e fecha
 *  com folga (300ms) ao sair — evita expandir ao cruzar a borda de passagem e
 *  colapsar ao mover o mouse para a página. */
export function useEdgeHover() {
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
 * Composer da tela cheia: é o MESMO input do chat de código (CodeInput) — com
 * modelo, modo de permissão, toggles, comandos "/", anexos e os badges de
 * elemento selecionado. Antes era um textarea próprio, que ia ficando para trás
 * a cada recurso novo do input principal.
 *
 * Recolhido por padrão: só a alça na borda inferior fica visível. O hover na
 * parte de baixo abre o composer; "fixar" o mantém aberto. O container externo
 * não captura o mouse (pointer-events-none) — só o painel, para o hover não
 * disparar na área da página acima dele.
 */
export function FullscreenComposer({
  pinned,
  onTogglePin,
  onSent,
  fromBrowser = false,
}: {
  pinned: boolean
  onTogglePin: () => void
  onSent?: () => void
  /** Pedido feito do próprio navegador: o agente pode usá-lo mesmo com as
   *  ferramentas de navegador desligadas nas Preferências. */
  fromBrowser?: boolean
}) {
  const { t } = useTranslation()
  const { hovered, handleEnter, handleLeave } = useEdgeHover()
  const expanded = pinned || hovered
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
      void sendMessage("code", text, {
        options: fromBrowser ? { ...options, fromBrowser: true } : options,
        directory,
        extraDirectories,
        sessionId,
        files,
      })
      onSent?.()
    },
    [sendMessage, sessionId, onSent, fromBrowser],
  )

  const handleStop = useCallback(() => {
    if (sessionId) stopStreaming(sessionId)
  }, [sessionId, stopStreaming])

  return (
    <div
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4"
    >
      <div
        className={cn(
          "pointer-events-auto w-full max-w-2xl rounded-t-xl border border-b-0 bg-background/95 shadow-lg backdrop-blur transition-transform duration-300 ease-out",
          // A alça (h-7) é o que sobra visível quando recolhido
          expanded ? "translate-y-0" : "translate-y-[calc(100%-1.75rem)]",
        )}
      >
        <div className="relative flex h-7 items-center justify-center">
          <span className="h-1 w-10 rounded-full bg-muted-foreground/40" />
          <button
            type="button"
            onClick={onTogglePin}
            title={pinned ? t("browser.unpinFeed") : t("browser.pinFeed")}
            className={cn(
              "absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground",
              pinned && "text-primary hover:text-primary",
            )}
          >
            {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
          </button>
        </div>
        {/* Fundo opaco próprio: o InputGroup do CodeInput é semitransparente e,
            sobre a página em tela cheia, ficaria ilegível. */}
        <div className="px-3">
          <CodeInput
            onSubmit={handleSubmit}
            status={status}
            onStop={handleStop}
            hasMessages={messages.length > 0}
            sessionId={sessionId}
            showFolders={false}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * Sidebar flutuante da tela cheia, com a aparência da sidebar padrão do app
 * (variant="floating": cantos arredondados, `bg-sidebar`, sombra e anel
 * `sidebar-border`, 8px de respiro das bordas, 200ms linear).
 *
 * - `open` = fixada aberta; o botão flutuante ao LADO do painel alterna.
 * - O painel ocupa toda a altura (top-2/bottom-2) e o botão fica ao lado dele,
 *   alinhado ao topo, encostado na borda interna quando aberta; fechada, ele
 *   recua para a borda da tela (continua clicável para reabrir).
 * - Fechada, encostar na borda (faixa de 6px) abre sob hover e sair fecha —
 *   igual à sidebar padrão no modo "hover".
 * O container externo não captura o mouse: só a faixa, o botão e o painel.
 */
export function FloatingSidebar({
  side,
  open,
  onToggle,
  openLabel,
  closeLabel,
  width = 288,
  children,
}: {
  side: "left" | "right"
  open: boolean
  onToggle: () => void
  openLabel: string
  closeLabel: string
  /** Largura do painel em px (o botão se posiciona a partir dela). */
  width?: number
  children: ReactNode
}) {
  const { hovered, handleEnter, handleLeave } = useEdgeHover()
  const visible = open || hovered
  const left = side === "left"
  const ToggleIcon = left ? SidebarLeftIcon : SidebarRightIcon
  // Botão ao lado do painel: 8px de respiro da tela + a largura da sidebar +
  // 6px de folga. Fechado, ele volta para a borda (8px).
  const toggleOffset = visible ? 8 + width + 6 : 8

  return (
    <div
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className={cn("pointer-events-none absolute inset-y-0 z-30 w-0", left ? "left-0" : "right-0")}
    >
      {/* Faixa de hover na borda: só enquanto a sidebar está fechada */}
      {!visible && <div className={cn("pointer-events-auto absolute inset-y-0 w-1.5", left ? "left-0" : "right-0")} />}
      <button
        type="button"
        onClick={onToggle}
        title={open ? closeLabel : openLabel}
        aria-label={open ? closeLabel : openLabel}
        className="pointer-events-auto absolute top-2 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-all duration-200 ease-linear hover:bg-muted hover:text-foreground"
        style={left ? { left: toggleOffset } : { right: toggleOffset }}
      >
        <ToggleIcon open={open} className="size-4" />
      </button>
      <div
        aria-hidden={!visible}
        className={cn(
          "absolute top-2 bottom-2 flex flex-col overflow-hidden rounded-lg bg-sidebar text-sidebar-foreground shadow-sm ring-1 ring-sidebar-border transition-transform duration-200 ease-linear",
          left ? "left-2" : "right-2",
          visible
            ? "pointer-events-auto translate-x-0"
            : cn("pointer-events-none", left ? "-translate-x-[calc(100%+0.75rem)]" : "translate-x-[calc(100%+0.75rem)]"),
        )}
        style={{ width }}
      >
        {children}
      </div>
    </div>
  )
}

/** Ícones de sidebar com o estado: "fechar" quando aberta, "abrir" quando não. */
function SidebarLeftIcon({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d={open ? "m16 15-3-3 3-3" : "m14 9 3 3-3 3"} />
    </svg>
  )
}

function SidebarRightIcon({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
      <path d={open ? "m8 9 3 3-3 3" : "m10 15-3-3 3-3"} />
    </svg>
  )
}

/** Listas estáveis para os seletores do zustand (evitam re-render por referência nova). */
const NO_MSGS: ChatMessage[] = []
const NO_ASKS: PendingAskUI[] = []

/** Conversa ao vivo — painel recolhido na borda esquerda das telas cheias
 *  (navegador, Motion) e dos painéis do Computer Use. Mostra o streaming do
 *  agente em tempo real. Sem `sessionId`, segue a sessão de código ativa.
 *  `onHoverChange` avisa quando o mouse entra/sai (a janela dos painéis do
 *  Computer Use só captura clique sobre eles). */
export function FullscreenChatFeed({
  pinned,
  onTogglePin,
  sessionId: fixedSessionId,
  title,
  onHoverChange,
}: {
  pinned: boolean
  onTogglePin: () => void
  sessionId?: string
  title?: string
  onHoverChange?: (over: boolean) => void
}) {
  const { t } = useTranslation()
  const activeSession = useActiveSession("code")
  const sessionId = fixedSessionId ?? activeSession?.id
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] ?? NO_MSGS : NO_MSGS))
  const status = useSessionStatus(sessionId)
  const pendingAsks = useSessionStore((s) => (sessionId ? s.pendingAsks[sessionId] ?? NO_ASKS : NO_ASKS))
  const isBusy = status === "submitted" || status === "streaming" || status === "cancelling" || status === "fallback"
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
    // Só a abertura importa aqui — scrollToBottom é estável.
  }, [expanded])

  // Auto-scroll: novas mensagens / deltas do streaming / asks mudam a lista
  useEffect(() => {
    if (visibleMessages.length > prevLength.current) scrollToBottom()
    prevLength.current = visibleMessages.length
    // Depende do tamanho, não da identidade da lista (que muda a cada delta).
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
      onMouseEnter={() => {
        handleEnter()
        onHoverChange?.(true)
      }}
      onMouseLeave={() => {
        handleLeave()
        onHoverChange?.(false)
      }}
      className="pointer-events-auto absolute left-0 top-1/2 z-10 flex -translate-y-1/2 items-center"
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
                {title ?? (fixedSessionId ? t("computer.panels.chat") : activeSession?.title) ?? t("browser.chatFeed")}
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
                            {/* Mesmo corpo do chat principal: a citação da
                                mensagem respondida não pode sair como texto
                                cru (`> [assistant] …`) na tela cheia. */}
                            <div className="text-sm">
                              <UserMessageText text={visibleMessageText(msg)} />
                            </div>
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

/** Uma ação do agente no feed: a tool, o rótulo legível e o resumo da saída. */
export interface FeedAction {
  part: ToolPart
  label: string
}

/**
 * Ações do agente — painel recolhido na borda direita das telas cheias e dos
 * painéis do Computer Use, com pin como o da conversa. Lista as tools da
 * sessão, da mais recente para a mais antiga: estado, rótulo e a primeira linha
 * da saída (clique mostra a saída inteira).
 */
export function ActionsFeed({
  sessionId: fixedSessionId,
  pinned,
  onTogglePin,
  title,
  icon: Icon,
  filter,
  describe,
  headerExtra,
  onHoverChange,
  limit = 60,
}: {
  sessionId?: string
  pinned: boolean
  onTogglePin: () => void
  title: string
  icon: LucideIcon
  /** Quais tools entram (padrão: todas) */
  filter?: (part: ToolPart) => boolean
  /** Rótulo legível da ação (padrão: o título da tool ou o nome dela) */
  describe?: (part: ToolPart) => string
  headerExtra?: ReactNode
  onHoverChange?: (over: boolean) => void
  limit?: number
}) {
  const { t } = useTranslation()
  const activeSession = useActiveSession("code")
  const sessionId = fixedSessionId ?? activeSession?.id
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] ?? NO_MSGS : NO_MSGS))
  const status = useSessionStatus(sessionId)
  const isBusy = status === "submitted" || status === "streaming" || status === "cancelling" || status === "fallback"
  const { hovered, handleEnter, handleLeave } = useEdgeHover()
  const expanded = pinned || hovered

  const actions = useMemo(() => {
    const list: ToolPart[] = []
    for (let i = messages.length - 1; i >= 0 && list.length < limit; i--) {
      const parts = messages[i].parts
      for (let j = parts.length - 1; j >= 0 && list.length < limit; j--) {
        const part = parts[j]
        if (part.type === "tool" && (!filter || filter(part))) list.push(part)
      }
    }
    return list
  }, [messages, filter, limit])
  const running = actions[0]?.state === "running"

  return (
    <div
      onMouseEnter={() => {
        handleEnter()
        onHoverChange?.(true)
      }}
      onMouseLeave={() => {
        handleLeave()
        onHoverChange?.(false)
      }}
      className="pointer-events-auto absolute right-0 top-1/2 z-30 flex -translate-y-1/2 items-center"
    >
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-l-xl border border-r-0 bg-background/95 shadow-lg backdrop-blur transition-all duration-300 ease-out",
          expanded ? "h-[min(72vh,600px)] w-80" : "h-12 w-9",
        )}
      >
        <button
          type="button"
          onClick={onTogglePin}
          title={title}
          className="flex h-12 w-full shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="relative flex items-center justify-center">
            <Icon className="size-4" />
            {(running || isBusy) && <FeedPulse className="absolute -right-1.5 -top-1.5" />}
          </span>
        </button>
        {expanded && (
          <div className="flex min-h-0 flex-1 animate-in flex-col fade-in-0 duration-200">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
              {headerExtra}
              <FeedPinButton pinned={pinned} onToggle={onTogglePin} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {actions.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">{t("computer.panels.empty")}</p>
              ) : (
                actions.map((part, i) => (
                  <ActionRow key={part.id} part={part} label={describe ? describe(part) : part.title || part.tool} latest={i === 0} />
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ActionRow({ part, label, latest }: { part: ToolPart; label: string; latest: boolean }) {
  const [open, setOpen] = useState(false)
  const detail = part.state === "error" ? part.error : part.output
  // A primeira linha da saída é o resumo ("Pressed element 2 (button "Salvar") via AXPress.").
  const summary = detail?.split("\n").find((line) => line.trim())?.trim()
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-muted/60",
        latest ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span className="mt-0.5 shrink-0">
        {part.state === "running" ? (
          <Loader2Icon className="size-3 animate-spin text-primary-foreground dark:text-primary" />
        ) : part.state === "error" ? (
          <XIcon className="size-3 text-destructive" />
        ) : (
          <CheckIcon className="size-3 text-emerald-500" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        {summary && (
          <span className={cn("mt-0.5 block whitespace-pre-wrap break-words text-muted-foreground", !open && "line-clamp-2")}>
            {open ? detail : summary}
          </span>
        )}
      </span>
    </button>
  )
}

/** Pin dos feeds laterais: fixa o painel aberto (o hover só abre enquanto o mouse está nele). */
export function FeedPinButton({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onToggle}
      title={pinned ? t("browser.unpinFeed") : t("browser.pinFeed")}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground",
        pinned && "text-primary hover:text-primary",
      )}
    >
      {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
    </button>
  )
}

function FeedPulse({ className }: { className?: string }) {
  return (
    <span className={cn("flex size-2", className)}>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-primary" />
    </span>
  )
}
