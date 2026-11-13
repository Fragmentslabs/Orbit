import { isValidElement, useMemo, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  Eye,
  FileTextIcon,
  Loader2Icon,
  MessageSquareQuoteIcon,
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
import { parseMessageReply, replyExcerpt, replySnippet } from "@shared/chat"
import type { AgentPart, ChatMessage, MessageErrorKind, ReasoningPart, RoutineRunPart, ToolPart } from "@shared/chat"
import { useMessageReply } from "@/src/stores/message-reply"
import { useReplyLabel } from "@/src/components/reply-bar"
import { ModalityIcons } from "@/src/components/ai/modality-icons"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { hostnameOf, messageText, speakableText, visibleMessageText } from "@/src/lib/message-utils"
import { formatDuration, formatTime } from "@/src/lib/format"
import { useSessionStore } from "@/src/stores/session-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { classifyMarkdownLink, linkifyMemoryIds, rescueLegacyCitations, type SourceRef } from "@/src/lib/citations"
import { chatRemarkPlugins } from "@/src/lib/remark-line-breaks"
import { chatApi } from "@/src/lib/ipc"
import { Actions, Action } from "@/src/components/ai/actions"
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationSource,
} from "@/src/components/ai/inline-citation"
import { MessageResponse } from "@/src/components/ai/message"
import { OrbitUiHostContext } from "@/src/components/ai/generative-ui"
import { AgentAvatars } from "@/src/components/routines/agent-avatars"
import { DiffBadge } from "@/src/components/messages/diff-badge"
import { MemoryCitation, MemoryIdText } from "@/src/components/messages/memory-citation"
import { MessageUsage } from "@/src/components/messages/message-usage"
import { SpeakAction } from "@/src/components/messages/speak-action"
import { Reasoning, ReasoningContent, ReasoningTrigger, useReasoning } from "@/src/components/ai/reasoning"
import { Shimmer } from "@/src/components/ai/shimmer"
import { Truncate } from "@/components/ui/truncated-text"

import { Hint } from "@/components/ui/hint"
/** Message pieces shared between the chat and code modes. */

/** Ceiling per provider in the model switch menu of the error card. */
const MAX_SWITCH_MODELS = 20

function childrenToText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(childrenToText).join("")
  if (isValidElement(children)) return childrenToText(children.props.children as ReactNode)
  return ""
}



/** Document citation: it opens the source in the panel, at the quoted excerpt. */
function SourceCitation({ source, label, sessionId }: {
  source: SourceRef
  label: string
  sessionId?: string
}) {
  const { t } = useTranslation()
  const openSourceTab = usePanelStore((s) => s.openSourceTab)
  const where = source.fromLine
    ? source.toLine && source.toLine > source.fromLine
      ? t("chat.citationLineRange", { page: source.page, from: source.fromLine, to: source.toLine })
      : t("chat.citationLine", { page: source.page, from: source.fromLine })
    : t("chat.citationPage", { page: source.page })
  return (
    <Hint label={`${source.docId} — ${where}`}>
      <button
        type="button"
        onClick={() => {
          if (!sessionId) return
          openSourceTab(sessionId, { ...source, title: source.docId })
        }}
        className="mx-0.5 inline-flex cursor-pointer items-center gap-0.5 rounded bg-primary/10 px-1.5 align-baseline text-[0.7rem] font-medium text-primary hover:bg-primary/20"
      >
        <
    FileTextIcon className="size-2.5" />
      {label.replace(/[[\]]/g, "")}
    </button>
    </Hint>
  )
}

/**
 * Markdown links whose text is only a number ([1](url)) become inline
 * citations with a hover card; the others open as normal links.
 */
function makeMarkdownLink(sessionId?: string): Components["a"] {
  return function MarkdownLink({ href, children, ...props }) {
    const text = childrenToText(children).trim()
    // The decision (and its why) lives in classifyMarkdownLink, with a test.
    const link = classifyMarkdownLink(href, text)
    if (link.kind === "source") {
      return <SourceCitation source={link.source} label={text} sessionId={sessionId} />
    }
    if (link.kind === "broken-source") {
      return <span className="text-muted-foreground">{children}</span>
    }
    if (link.kind === "memory") {
      return <MemoryCitation memoryId={link.memoryId} label={text} sessionId={sessionId} />
    }
    if (link.kind === "broken-memory") {
      return <span className="text-muted-foreground">{children}</span>
    }
    if (link.kind === "web-citation" && href) {
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
}

/**
 * Assistant Markdown with support for inline citations. `muted` marks the
 * intermediate narration (text the model writes between tools,
 * "thinking out loud") so as not to be confused with the final answer.
 *
 * `sessionId` exists because of the document citation: opening the source in the
 * panel needs to know which conversation it belongs to (the `doc1` id of one chat is another
 * file in another chat). Without it the citation still appears, but inert.
 */
export function AssistantMarkdown({ children, muted = false, sessionId }: {
  children: string
  muted?: boolean
  sessionId?: string
}) {
  const components = useMemo(() => ({ a: makeMarkdownLink(sessionId) }), [sessionId])
  // The buttons of the orbit-ui blocks talk to the session of this reply.
  const host = useMemo(() => ({ sessionId }), [sessionId])
  // Replies recorded before the format change keep the old citation,
  // which the sanitizer takes down; the rewrite here gives the click back to them without
  // touching the history on disk. The same goes for the memory id written
  // loose: it becomes a chip in the rendering, including in old replies.
  const text = useMemo(() => linkifyMemoryIds(rescueLegacyCitations(children)), [children])
  return (
    <div
      className={cn(
        // Color inheritance (without [&_*]) so Shiki can color tokens in the code blocks
        muted ? "text-sm text-muted-foreground" : "text-foreground",
        "[&_[data-streamdown=code-block]]:text-foreground",
      )}
    >
      <OrbitUiHostContext.Provider value={host}>
        <MessageResponse components={components}>{text}</MessageResponse>
      </OrbitUiHostContext.Provider>
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

export function ReasoningPartView({ part, flat }: { part: ReasoningPart; flat?: boolean }) {
  // Only the reasoning that is arriving now is born open (and it closes by itself on
  // finishing). The already finished one is born CLOSED: open, each block mounted the
  // whole markdown only to close 1s later — in a chat with hundreds of
  // reasonings, that was seconds of render when opening the conversation. Decided at
  // mount: the end of the streaming cannot change defaultOpen in the middle.
  const [openAtMount] = useState(part.state === "streaming")
  if (!part.text) return null
  // Detailed mode: the reasoning at length, without an accordion.
  if (flat) {
    return (
      <div className="w-full border-l-2 border-border pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
        {part.text}
      </div>
    )
  }
  return (
    <Reasoning
      isStreaming={part.state === "streaming"}
      defaultOpen={openAtMount}
      duration={part.durationMs ? Math.max(1, Math.round(part.durationMs / 1000)) : undefined}
      className="w-full"
    >
      <ReasoningTrigger />
      <ReasoningContent>{part.text}</ReasoningContent>
    </Reasoning>
  )
}

/** Header of the agent accordion: icon per role + label + state.
 * Internal component to read isOpen from the Reasoning context (chevron). */
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

/** /init agent accordion (thinking style): it auto-opens while the
 * agent works (streaming of what it is doing) and closes on completion. */
export function AgentPartView({ part }: { part: AgentPart }) {
  // Same reason as ReasoningPartView: finished is born closed.
  const [openAtMount] = useState(part.state === "running")
  return (
    <Reasoning
      isStreaming={part.state === "running"}
      defaultOpen={openAtMount}
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

/** Generic fallback for tools without a dedicated view. */
export function GenericToolView({ part, label, subtitle, sessionId }: {
  part: ToolPart
  label: string
  subtitle?: string
  /** Where to open the cited memory: the panel tab belongs to this session. */
  sessionId?: string
}) {
  const [open, setOpen] = useState(false)
  const detail = part.error ?? part.output

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="not-prose my-1.5 w-full">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-left text-xs hover:bg-muted/70">
        {part.state === "running" ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
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
          <Truncate text={subtitle}>
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{subtitle}</span>
          </Truncate>
        )}
        <ChevronDownIcon
          className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {detail && (
          <pre className="mt-1 max-h-64 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            <MemoryIdText text={detail} sessionId={sessionId} />
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Model switch menu offered in the error card. It exists because moderation and
 * model unavailable failures belong to the provider, not to the request: repeating the
 * same call reproduces the same error — only another model solves it. It selects the
 * model and resends the turn in one click.
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
          // Models that accept images first: the most common trigger of these
          // blocks is precisely a turn with an image in the context.
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
            aria-label={t("chat.switchModel")}
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
                
                  <Truncate>
                      <span className="flex-1 truncate">{model.name}</span>
                  </Truncate>
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
  attempts,
  failedModel,
  onRetry,
}: {
  sessionId?: string
  error: string
  kind?: MessageErrorKind
  /** Attempts made in the background before giving up (only when > 1) */
  attempts?: number
  failedModel?: { providerId?: string; modelId?: string }
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  // A classified failure has its own explanation (chat.errorKind.*); the raw text
  // becomes a secondary detail (it is never discarded — it is what allows
  // diagnosing). Only `unknown` has no explanation and shows the raw text.
  const explained = kind !== undefined && kind !== "unknown"
  // Overflowed context is the only classified failure in which switching models
  // is not a way out: the giant request goes the same to the next one. Offering the menu
  // here would send the person to try again through the path that does not work — what
  // solves it is shrinking the conversation.
  const overflowed = kind === "context-length"
  // Overflow in the middle of the turn: the history fit, what went past the window was the
  // work of the reply itself. Neither compacting nor switching models helps —
  // the explanation guides to ask to continue (the new turn does not resend the
  // tool results of this one).
  const turnOverflowed = kind === "context-length-turn"

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <div className="flex items-start justify-between gap-2">
        <span className="flex-1">
          {explained ? t(`chat.errorKind.${kind}`) : error}
          {attempts && attempts > 1 && <> {t("chat.failedAfterAttempts", { count: attempts })}</>}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {overflowed && sessionId && (
            <button
              type="button"
              onClick={() => chatApi.compact(sessionId)}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-destructive hover:bg-destructive/20"
            >
              <SparklesIcon className="size-3.5" />
              {t("usage.compactNow")}
            </button>
          )}
          {explained && !overflowed && !turnOverflowed && (
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

/** The reply stopped for reaching the step ceiling, not by the model's decision —
 * without this, it is indistinguishable from a normal conclusion (see message.truncated). */
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

/** Time between the start and the completion of the assistant reply (createdAt → completedAt). */
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

/**
 * Reply: marks the message as context in the composer.
 *
 * The excerpt enters the TEXT of the next send (see formatMessageReply), so what
 * comes out of here is only the cut — the composer is what builds and clears it. A message
 * without text (a reply of tools only, for example) does not offer the action:
 * there would be nothing to quote.
 */
export function ReplyAction({ message, sessionId }: { message: ChatMessage; sessionId?: string }) {
  const { t } = useTranslation()
  const setReply = useMessageReply((s) => s.setReply)
  const text = replyExcerpt(visibleMessageText(message))
  if (!text) return null

  return (
    <Action
      tooltip={t("reply.action")}
      label={t("reply.action")}
      onClick={() => setReply(sessionId, { role: message.role, text })}
    >
      <MessageSquareQuoteIcon className="size-3.5" />
    </Action>
  )
}

/**
 * Assistant action bar: copy + reply + speak + time +
 * tokens/cost on the left, and the diff badge (+N -N) in the right corner.
 *
 * The badge stays here, and not in the header of the actions accordion, because this row
 * is the only one that is always there after the turn ends: collapsed, the
 * accordion hides precisely the balance of what changed on disk.
 */
export function AssistantMessageActions({ message, sessionId }: { message: ChatMessage; sessionId?: string }) {
  const { t, i18n } = useTranslation()
  const openChatTab = usePanelStore((s) => s.openChatTab)
  const execution = message.parts.find((part): part is RoutineRunPart => part.type === "routine-run")
  const agents = execution?.agents ?? []
  return (
    <Actions className="mt-1 w-full items-center justify-between">
      <div className="flex items-center gap-1">
        <CopyAction text={messageText(message)} />
        <ReplyAction message={message} sessionId={sessionId} />
        {/* The speech reads the FINAL ANSWER (see speakableText), not all the content
            the copy takes — attachment, reasoning and narration stay out. */}
        <SpeakAction text={speakableText(message)} />
        <MessageTimestamp timestamp={message.completedAt ?? message.createdAt} />
        {message.completedAt && <MessageDuration startedAt={message.createdAt} completedAt={message.completedAt} />}
        {message.tokens && <MessageUsage tokens={message.tokens} />}
      </div>
      {/* The team of the execution, at the right end of the reading row. The stack is the way
          into the execution's own trace (tools, workers), which stays detail — never the answer. */}
      {execution && agents.length > 0 ? (
        <button
          type="button"
          title={t("routines.card.details")}
          aria-label={t("routines.card.details")}
          onClick={() =>
            openChatTab(
              execution.sessionId,
              `${t("routines.card.execution")} ${formatTime(execution.startedAt, i18n.language)}`,
            )
          }
          className="rounded-full opacity-80 transition-opacity hover:opacity-100"
        >
          <AgentAvatars names={agents} size={18} max={4} ring="border-background" />
        </button>
      ) : (
        <DiffBadge
          patch={message.snapshot?.patch}
          authored={message.snapshot?.authored}
          parts={message.parts}
          sessionId={sessionId}
          messageId={message.id}
        />
      )}
    </Actions>
  )
}

/**
 * BUBBLE scale for the user markdown.
 *
 * streamdown was designed for the whole reply (h1 at `text-3xl`, 16px
 * between blocks); in a two-line message that becomes disproportionate. Here
 * the headings go down to the body scale and the blocks come closer.
 *
 * The classes go in LITERAL form in a single string: Tailwind scans the source text,
 * and a variant built at runtime does not reach the generated CSS — the rule would disappear with
 * no error at all (same reason as IMAGE_LAYOUT in components/ai/message.tsx).
 */
const USER_MARKDOWN_LAYOUT = [
  "space-y-2",
  "[&_h1]:text-base [&_h2]:text-base [&_h3]:text-sm [&_h4]:text-sm [&_h5]:text-sm [&_h6]:text-sm",
  "[&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-2 [&_h4]:mt-2 [&_h5]:mt-2 [&_h6]:mt-2",
  "[&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_h4]:mb-1 [&_h5]:mb-1 [&_h6]:mb-1",
  "[&_li]:py-0.5 [&_blockquote]:my-2 [&_hr]:my-3",
].join(" ")

/**
 * Markdown of the USER message.
 *
 * The composer stays raw on purpose — whoever types sees the characters they
 * typed —, but the bubble delivers the read text: code block with highlight,
 * table, list and link. It is the SAME engine as the reply (streamdown) on purpose:
 * the same excerpt pasted by the person and by the model has to come out the same.
 *
 * Two differences from AssistantMarkdown:
 * - no source/memory citation — a link typed by the user is just a link;
 * - no repair of streaming markdown (`mode="static"`): the message is already
 *   whole, and "fixing" a loose `**` would change what the person wrote.
 *
 * The simple line break keeps counting (see remark-line-breaks): one
 * idea per line comes out one idea per line.
 */
function UserMessageMarkdown({ text }: { text: string }) {
  return (
    <MessageResponse
      mode="static"
      parseIncompleteMarkdown={false}
      remarkPlugins={chatRemarkPlugins}
      className={USER_MARKDOWN_LAYOUT}
    >
      {text}
    </MessageResponse>
  )
}

/**
 * Quote of the replied message, ABOVE the bubble — a pill on the chat surface,
 * not a block inside the bubble.
 *
 * The recorded text keeps the quote together with the body — it is what makes the
 * model and the copy of the message receive both —, and here the quote is taken
 * out only for the reading: it becomes this pill, and `UserMessageText` shows the rest.
 *
 * The drawing is the badge of the composer's row (same icon, same gold name), with
 * two differences: no X — in the sent message it is a record of what was answered,
 * not something to undo — and no chip behind the icon.
 *
 * `bg-foreground/10` is translucent on purpose: the same message is drawn over the
 * chat background and over the sidebar of the panel, which are two different
 * colors, and a fixed one would sink into one of them. Being a veil, it lifts by
 * the same amount over both.
 */
export function UserMessageQuote({ text }: { text: string }) {
  const label = useReplyLabel()
  const { reply } = parseMessageReply(text)
  if (!reply) return null

  return (
    <div className="mb-1 ml-auto flex h-7 w-fit max-w-[85%] select-none items-center gap-1.5 rounded-full bg-foreground/10 px-3 text-xs">
      <MessageSquareQuoteIcon className="size-3 shrink-0 text-primary" />
      <span className="shrink-0 font-medium text-primary">{label(reply.role)}</span>
      <span className="text-muted-foreground">·</span>
      <span className="min-w-0 truncate text-muted-foreground">{replySnippet(reply.text)}</span>
    </div>
  )
}

/**
 * Text of the user message. The quote of the replied message is NOT drawn here:
 * it is the pill above the bubble (`UserMessageQuote`), which is what keeps the
 * bubble the size of what was actually written.
 */
export function UserMessageText({ text }: { text: string }) {
  const { reply, body } = parseMessageReply(text)
  if (!reply) return <UserMessageMarkdown text={text} />
  return body.trim() ? <UserMessageMarkdown text={body} /> : null
}

/**
 * Revert offered in the USER message: it discards that turn and everything after
 * it (in code mode, it also undoes the changes on disk) and gives the text
 * and the attachments back to the input, as if the message were being edited.
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

/** User message: text + actions (copy + reply + send time). */
export function UserMessageBody({ message, sessionId }: { message: ChatMessage; sessionId?: string }) {
  return (
    <div className="group/user-msg flex flex-col gap-0.5">
      <UserMessageQuote text={visibleMessageText(message)} />
      <UserMessageText text={visibleMessageText(message)} />
      <Actions className="-mb-1 items-center justify-end opacity-0 transition-opacity group-hover/user-msg:opacity-100">
        <MessageTimestamp timestamp={message.createdAt} />
        <CopyAction text={visibleMessageText(message)} />
        <ReplyAction message={message} sessionId={sessionId} />
      </Actions>
    </div>
  )
}
