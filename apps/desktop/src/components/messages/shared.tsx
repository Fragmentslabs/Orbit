import { isValidElement, useState, type ReactNode } from "react"
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  LoaderIcon,
  RotateCwIcon,
  SparklesIcon,
  TerminalIcon,
  Undo2Icon,
  XCircleIcon,
} from "lucide-react"
import type { Components } from "streamdown"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { AgentPart, ChatMessage, ReasoningPart, ToolPart } from "@shared/chat"
import { hostnameOf, messageText } from "@/src/lib/message-utils"
import { useSessionStore } from "@/src/stores/session-store"
import { Actions, Action } from "@/src/components/ai/actions"
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationSource,
} from "@/src/components/ai/inline-citation"
import { MessageResponse } from "@/src/components/ai/message"
import { MessageUsage } from "@/src/components/messages/message-usage"
import { Reasoning, ReasoningContent, ReasoningTrigger, useReasoning } from "@/src/components/ai/reasoning"
import { Shimmer } from "@/src/components/ai/shimmer"

/** Peças de mensagem compartilhadas entre os modos chat e código. */

function childrenToText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(childrenToText).join("")
  if (isValidElement(children)) return childrenToText(children.props.children as ReactNode)
  return ""
}

const CITATION_TEXT = /^\[?\d{1,3}\]?$/

/**
 * Links markdown cujo texto é apenas um número ([1](url)) viram citações
 * inline com hover card; os demais abrem como links normais.
 */
const MarkdownLink: Components["a"] = ({ href, children, ...props }) => {
  const text = childrenToText(children).trim()
  if (href && CITATION_TEXT.test(text)) {
    return (
      <InlineCitation>
        <InlineCitationCard>
          <InlineCitationCardTrigger sources={[href]} />
          <InlineCitationCardBody className="p-3">
            <InlineCitationSource title={hostnameOf(href)} url={href} />
          </InlineCitationCardBody>
        </InlineCitationCard>
      </InlineCitation>
    )
  }
  return (
    <a href={href} rel="noreferrer" target="_blank" {...props}>
      {children}
    </a>
  )
}

const markdownComponents: Components = { a: MarkdownLink }

/**
 * Markdown do assistente com suporte a citações inline. `muted` marca a
 * narração intermediária (texto que o modelo escreve entre ferramentas,
 * "pensando alto") para não se confundir com a resposta final.
 */
export function AssistantMarkdown({ children, muted = false }: {
  children: string
  muted?: boolean
}) {
  return (
    <div
      className={cn(
        // Herança de cor (sem [&_*]) para o Shiki poder colorir tokens nos code blocks
        muted ? "text-sm text-muted-foreground" : "text-foreground",
        "[&_[data-streamdown=code-block]]:text-foreground",
      )}
    >
      <MessageResponse components={markdownComponents}>{children}</MessageResponse>
    </div>
  )
}

export function ReasoningPartView({ part }: { part: ReasoningPart }) {
  if (!part.text) return null
  return (
    <Reasoning
      isStreaming={part.state === "streaming"}
      duration={part.durationMs ? Math.max(1, Math.round(part.durationMs / 1000)) : undefined}
      className="w-full"
    >
      <ReasoningTrigger />
      <ReasoningContent>{part.text}</ReasoningContent>
    </Reasoning>
  )
}

/** Cabeçalho do acordeon de agente: ícone por papel + label + estado.
 * Componente interno para ler isOpen do contexto do Reasoning (chevron). */
function AgentTriggerBody({ part }: { part: AgentPart }) {
  const { isOpen } = useReasoning()
  const Icon = part.role === "main" ? SparklesIcon : BotIcon
  const seconds = part.durationMs ? Math.max(1, Math.round(part.durationMs / 1000)) : undefined
  return (
    <>
      <Icon className="size-4 shrink-0" />
      {part.state === "running" ? (
        <Shimmer duration={1}>
          {part.role === "main" ? part.label : `Explorando ${part.label}…`}
        </Shimmer>
      ) : (
        <p className={cn(part.state === "error" && "text-destructive")}>
          {part.label}
          {part.state === "error"
            ? " · falhou"
            : seconds !== undefined
              ? ` · ${seconds}s`
              : ""}
        </p>
      )}
      <ChevronDownIcon
        className={cn("size-4 shrink-0 transition-transform", isOpen ? "rotate-180" : "rotate-0")}
      />
    </>
  )
}

/** Acordeon de agente do /init (estilo thinking): auto-abre enquanto o
 * agente trabalha (streaming do que ele está fazendo) e fecha ao concluir. */
export function AgentPartView({ part }: { part: AgentPart }) {
  return (
    <Reasoning
      isStreaming={part.state === "running"}
      duration={part.durationMs ? Math.max(1, Math.round(part.durationMs / 1000)) : undefined}
      className="w-full !mb-1"
    >
      <ReasoningTrigger>
        <AgentTriggerBody part={part} />
      </ReasoningTrigger>
      <ReasoningContent className="!mt-2 max-h-72 overflow-y-auto rounded-lg border bg-muted/30 p-3 text-xs">
        {part.text || "…"}
      </ReasoningContent>
    </Reasoning>
  )
}

/** Fallback genérico para ferramentas sem visual dedicado. */
export function GenericToolView({ part, label, subtitle }: {
  part: ToolPart
  label: string
  subtitle?: string
}) {
  const [open, setOpen] = useState(false)
  const detail = part.error ?? part.output

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="not-prose my-1.5 w-full">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-left text-xs hover:bg-muted/70">
        {part.state === "running" ? (
          <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : part.state === "error" ? (
          <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {part.state === "running" ? (
          <Shimmer className="font-medium">{label}</Shimmer>
        ) : (
          <span className="font-medium">{label}</span>
        )}
        {subtitle && (
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{subtitle}</span>
        )}
        <ChevronDownIcon
          className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {detail && (
          <pre className="mt-1 max-h-64 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {detail}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function MessageError({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <span className="flex-1">{error}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-destructive hover:bg-destructive/20"
        >
          <RotateCwIcon className="size-3.5" />
          Retry
        </button>
      )}
    </div>
  )
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
}

export function MessageTimestamp({ timestamp }: { timestamp: number }) {
  return (
    <span className="select-none px-1 text-[11px] tabular-nums text-muted-foreground/70">
      {formatTime(timestamp)}
    </span>
  )
}

export function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <Action
      tooltip="Copiar"
      label="Copiar"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </Action>
  )
}

/** Barra de ações do assistente: copiar + revert + horário + tokens/custo. */
export function AssistantMessageActions({ message, sessionId }: {
  message: ChatMessage
  sessionId?: string
}) {
  const revertToMessage = useSessionStore((s) => s.revertToMessage)
  const activeRevert = useSessionStore((s) =>
    sessionId ? s.sessions.find((x) => x.id === sessionId)?.revert : undefined,
  )
  const canRevert = Boolean(sessionId && !activeRevert && (
    message.snapshot?.start || message.role === 'assistant'
  ))

  return (
    <Actions className="mt-1 items-center">
      <CopyAction text={messageText(message)} />
      {canRevert && (
        <Action
          tooltip="Reverter até aqui"
          label="Reverter até aqui"
          onClick={() => void revertToMessage(sessionId!, message.id)}
        >
          <Undo2Icon className="size-3.5" />
        </Action>
      )}
      <MessageTimestamp timestamp={message.createdAt} />
      {message.tokens && <MessageUsage tokens={message.tokens} />}
    </Actions>
  )
}

/** Mensagem do usuário: texto + ações (copiar + horário de envio). */
export function UserMessageBody({ message }: { message: ChatMessage }) {
  return (
    <div className="group/user-msg flex flex-col gap-0.5">
      <p className="whitespace-pre-wrap">{messageText(message)}</p>
      <Actions className="-mb-1 items-center justify-end opacity-0 transition-opacity group-hover/user-msg:opacity-100">
        <MessageTimestamp timestamp={message.createdAt} />
        <CopyAction text={messageText(message)} />
      </Actions>
    </div>
  )
}
