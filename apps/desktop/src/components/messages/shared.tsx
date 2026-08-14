import { isValidElement, useMemo, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  Eye,
  LoaderIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SparklesIcon,
  TerminalIcon,
  Undo2Icon,
  XCircleIcon,
} from "lucide-react"
import type { Components } from "streamdown"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { AgentPart, ChatMessage, MessageErrorKind, ReasoningPart, ToolPart } from "@shared/chat"
import { ModalityIcons } from "@/src/components/ai/modality-icons"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { hostnameOf, messageText, visibleMessageText } from "@/src/lib/message-utils"
import { formatDuration, formatTime } from "@/src/lib/format"
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

/** Teto por provedor no menu de troca de modelo do card de erro. */
const MAX_SWITCH_MODELS = 20

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

export function VisionWorkingRow() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Eye className="size-3.5" />
      <Shimmer>{t("chat.analyzingImage")}</Shimmer>
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
  const { t } = useTranslation()
  const { isOpen } = useReasoning()
  const Icon = part.role === "main" ? SparklesIcon : BotIcon
  const seconds = part.durationMs ? Math.max(1, Math.round(part.durationMs / 1000)) : undefined
  return (
    <>
      <Icon className="size-4 shrink-0" />
      {part.state === "running" ? (
        <Shimmer duration={1}>
          {part.role === "main" ? part.label : t("chat.exploring", { label: part.label })}
        </Shimmer>
      ) : (
        <p className={cn(part.state === "error" && "text-destructive")}>
          {part.label}
          {part.state === "error"
            ? ` · ${t("chat.failed")}`
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

/**
 * Menu de troca de modelo oferecido no card de erro. Existe porque falhas de
 * moderação e de modelo indisponível são do provedor, não do request: repetir a
 * mesma chamada reproduz o mesmo erro — só outro modelo resolve. Seleciona o
 * modelo e reenvia o turno em um clique.
 */
function SwitchModelMenu({
  sessionId,
  failedModel,
  onRetry,
}: {
  sessionId?: string
  failedModel?: { providerId?: string; modelId?: string }
  onRetry: () => void
}) {
  const { t } = useTranslation()
  const catalog = useProviderStore((s) => s.catalog)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)
  const selectModel = useSessionModelPrefs((s) => s.selectModel)

  const groups = useMemo(
    () =>
      connectedProviders
        .filter((id) => catalog[id])
        .map((id) => ({
          provider: catalog[id],
          // Modelos que aceitam imagem primeiro: o gatilho mais comum desses
          // bloqueios é justamente um turno com imagem no contexto.
          models: Object.values(catalog[id].models)
            .filter((m) => !(id === failedModel?.providerId && m.id === failedModel?.modelId))
            .sort((a, b) => {
              const av = a.modalities?.input?.includes("image") ? 0 : 1
              const bv = b.modalities?.input?.includes("image") ? 0 : 1
              return av - bv || (b.release_date ?? "").localeCompare(a.release_date ?? "")
            })
            .slice(0, MAX_SWITCH_MODELS),
        }))
        .filter((g) => g.models.length > 0),
    [catalog, connectedProviders, failedModel?.providerId, failedModel?.modelId],
  )

  if (groups.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-destructive hover:bg-destructive/20"
          />
        }
      >
        <RefreshCwIcon className="size-3.5" />
        {t("chat.switchModel")}
        <ChevronDownIcon className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
        {groups.map((group) => (
          <DropdownMenuGroup key={group.provider.id}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {group.provider.name}
            </DropdownMenuLabel>
            {group.models.map((model) => (
              <DropdownMenuItem
                key={`${group.provider.id}/${model.id}`}
                onClick={() => {
                  selectModel(sessionId, group.provider.id, model.id)
                  onRetry()
                }}
                className="gap-2"
              >
                <span className="flex-1 truncate">{model.name}</span>
                <ModalityIcons
                  modalities={model.modalities?.input}
                  className="size-3 shrink-0 text-muted-foreground"
                />
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function MessageError({
  sessionId,
  error,
  kind,
  failedModel,
  onRetry,
}: {
  sessionId?: string
  error: string
  kind?: MessageErrorKind
  failedModel?: { providerId?: string; modelId?: string }
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  // Falhas do provedor têm explicação própria; o texto cru vira detalhe
  // secundário (nunca é descartado — é o que permite diagnosticar).
  const explained = kind === "moderation" || kind === "model-unavailable"

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <div className="flex items-start justify-between gap-2">
        <span className="flex-1">{explained ? t(`chat.errorKind.${kind}`) : error}</span>
        <div className="flex shrink-0 items-center gap-1">
          {explained && (
            <SwitchModelMenu sessionId={sessionId} failedModel={failedModel} onRetry={() => onRetry?.()} />
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-destructive hover:bg-destructive/20"
            >
              <RotateCwIcon className="size-3.5" />
              {t("chat.retry")}
            </button>
          )}
        </div>
      </div>
      {explained && (
        <p className="mt-1 font-mono text-[11px] leading-relaxed break-words text-destructive/70">
          {error}
        </p>
      )}
    </div>
  )
}

/** Resposta parou por atingir o teto de passos, não por decisão do modelo —
 * sem isso, fica indistinguível de uma conclusão normal (ver message.truncated). */
export function MessageTruncated() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
      <span className="flex-1">
        {t("chat.stopped")}
      </span>
    </div>
  )
}

export function MessageTimestamp({ timestamp }: { timestamp: number }) {
  const { i18n } = useTranslation()
  const formatted = formatTime(timestamp, i18n.language)
  return (
    <span className="select-none px-1 text-[11px] tabular-nums text-muted-foreground/70">
      {formatted}
    </span>
  )
}

/** Tempo entre o início e a conclusão da resposta do assistant (createdAt → completedAt). */
export function MessageDuration({ startedAt, completedAt }: { startedAt: number; completedAt: number }) {
  const { t } = useTranslation()
  return (
    <span
      className="select-none px-1 text-[11px] tabular-nums text-muted-foreground/70"
      title={t("chat.responseDuration")}
    >
      {formatDuration(completedAt - startedAt)}
    </span>
  )
}

export function CopyAction({ text }: { text: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  return (
    <Action
      tooltip={t("chat.copy")}
      label={t("chat.copy")}
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

/** Barra de ações do assistente: copiar + horário + tokens/custo. */
export function AssistantMessageActions({ message }: { message: ChatMessage }) {
  return (
    <Actions className="mt-1 items-center">
      <CopyAction text={messageText(message)} />
      <MessageTimestamp timestamp={message.completedAt ?? message.createdAt} />
      {message.completedAt && <MessageDuration startedAt={message.createdAt} completedAt={message.completedAt} />}
      {message.tokens && <MessageUsage tokens={message.tokens} />}
    </Actions>
  )
}

/**
 * Revert oferecido na mensagem do USUÁRIO: descarta esse turno e tudo depois
 * dele (no modo código, também desfaz as alterações em disco) e devolve o texto
 * e os anexos ao input, como se a mensagem estivesse sendo editada.
 */
export function RevertAction({ messageId, sessionId }: {
  messageId: string
  sessionId?: string
}) {
  const { t } = useTranslation()
  const revertToMessage = useSessionStore((s) => s.revertToMessage)
  const activeRevert = useSessionStore((s) =>
    sessionId ? s.sessions.find((x) => x.id === sessionId)?.revert : undefined,
  )
  if (!sessionId || activeRevert) return null

  return (
    <Action
      tooltip={t("chat.revert")}
      label={t("chat.revert")}
      onClick={() => void revertToMessage(sessionId, messageId)}
    >
      <Undo2Icon className="size-3.5" />
    </Action>
  )
}

/** Mensagem do usuário: texto + ações (copiar + horário de envio). */
export function UserMessageBody({ message }: { message: ChatMessage }) {
  return (
    <div className="group/user-msg flex flex-col gap-0.5">
      <p className="whitespace-pre-wrap">{visibleMessageText(message)}</p>
      <Actions className="-mb-1 items-center justify-end opacity-0 transition-opacity group-hover/user-msg:opacity-100">
        <MessageTimestamp timestamp={message.createdAt} />
        <CopyAction text={visibleMessageText(message)} />
      </Actions>
    </div>
  )
}
