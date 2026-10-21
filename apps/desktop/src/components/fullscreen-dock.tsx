import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { PinIcon, PinOffIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ChatMessage, FilePart, SendMessageOptions } from "@shared/chat"
import { CodeInput } from "@/src/components/code-input"
import { useActiveSession, useSessionStatus, useSessionStore } from "@/src/stores/session-store"

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

const NO_MSGS: ChatMessage[] = []

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
