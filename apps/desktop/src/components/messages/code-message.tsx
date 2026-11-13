import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { AudioPartView } from "@/src/components/messages/audio-part"
import { VideoPartView } from "@/src/components/messages/video-part"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ChatMessage, ImagePart, MessagePart, ToolPart } from "@shared/chat"
import { useSetting } from "@/src/stores/app-settings"
import {
  arrangeForView,
  extractSources,
  isEngineText,
  isTestCommand,
  lastTextRunStart,
  parseTestSummary,
  type TestSummary,
} from "@/src/lib/message-utils"
import { ImageGroupView } from "@/src/components/ai/image"
import { ArtifactPartView } from "@/src/components/ai/artifact-part"
import { DocumentPartView } from "@/src/components/ai/document-part"
import { MotionBundleCard } from "@/src/components/messages/motion-bundle-card"
import { planMotionBundles } from "@/src/lib/motion-bundle"
import { useMotionBundleIndexes } from "@/src/stores/motion-bundles-store"
import { isPieceCardTool, landPieceCard } from "@/src/lib/piece-tools"
import { PieceCardView } from "@/src/components/ai/piece-card-view"
import { Shimmer } from "@/src/components/ai/shimmer"
import { DiffBadge } from "@/src/components/messages/diff-badge"
import { SubAgentCard } from "@/src/components/ai/sub-agent-card"
import { TodoList } from "@/src/components/ai/todo-list"
import { McpProposalCard } from "@/src/components/mcp-proposal-card"
import { AgentProposalCard } from "@/src/components/agent-proposal-card"
import { SkillProposalCard } from "@/src/components/skill-proposal-card"
import { RoutineRunCard } from "@/src/components/routines/run-card"
import { isRoutineProposal, RoutineProposalCard } from "@/src/components/routines/routine-proposal-card"
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/src/components/ai/sources"
import { Task, TaskContent, TaskTrigger } from "@/src/components/ai/task"
import { ToolActionItem } from "@/src/components/ai/actions-group"
import {
  TestResults,
  TestResultsHeader,
  TestResultsProgress,
  TestResultsSummary,
} from "@/src/components/ai/test-results"
import {
  AgentPartView,
  AssistantMarkdown,
  MessageError,
  MessageTruncated,
  ReasoningPartView,
  VisionWorkingRow,
} from "@/src/components/messages/shared"

/**
 * Assistant message in code mode: tools grouped into Tasks
 * (agent style), structured test results, reasoning and — in plan mode
 * with research — consulted sources.
 */

function testSummaryOf(part: ToolPart): TestSummary | null {
  if (part.tool !== "bash" || part.state !== "done" || !part.output) return null
  const command = typeof part.input?.command === "string" ? part.input.command : ""
  if (!isTestCommand(command)) return null
  return parseTestSummary(part.output)
}

function TestResultsBlock({ summary }: { summary: TestSummary }) {
  return (
    <TestResults summary={summary} className="my-1">
      <TestResultsHeader>
        <TestResultsSummary />
      </TestResultsHeader>
      <TestResultsProgress />
    </TestResults>
  )
}

const MAX_VISIBLE = 5

function TaskGroup({ parts, snapshot, sessionId, messageId, live, flat, showDiff }: {
  parts: ToolPart[]
  /** Detailed mode: title and all actions open, no accordion. */
  flat?: boolean
  snapshot?: { patch?: string; files?: string[]; authored?: string[] }
  sessionId?: string
  messageId?: string
  /** "+N -N" badge in the group header. The main chat turns it off: there it
   *  is rendered in the message footer, which stays always visible (see
   *  DiffBadge and AssistantMessageActions). */
  showDiff?: boolean
  /** The message is the last one and the turn is still streaming — only in that case
   *  is a "running" part real. Without this, an old message with a
   *  tool-call that never received a result (abort, dropped connection) kept
   *  showing "Working"/shimmer forever, even outside any active
   *  turn — chat-engine now closes those parts when saving, but a
   *  message already recorded and broken before that fix heals itself here. */
  live: boolean
}) {
  const { t } = useTranslation()
  const working = live && parts.some((p) => p.state === "running")
  const errors = parts.filter((p) => p.state === "error").length
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const prevWorking = useRef(working)

  // Opens automatically while it works
  useEffect(() => {
    if (working) setOpen(true)
  }, [working])

  // Auto-collapse 1s after the streaming ends
  useEffect(() => {
    if (prevWorking.current && !working) {
      const timer = setTimeout(() => setOpen(false), 1000)
      return () => clearTimeout(timer)
    }
    prevWorking.current = working
  }, [working])

  // Visible tools: the last MAX_VISIBLE ones (or all of them if showAll)
  const visibleParts = showAll ? parts : parts.slice(-MAX_VISIBLE)
  const hiddenCount = parts.length - MAX_VISIBLE

  // Resets showAll when the group changes (new message)
  useEffect(() => { setShowAll(false) }, [parts.length])

  const title = working
    ? t("chat.code.working")
    : errors > 0
      ? t("chat.code.actionsWithError", { count: parts.length, errors })
      : t("chat.code.actionsDone", { count: parts.length })

  const items = (flat ? parts : visibleParts).map((part) => {
    const summary = testSummaryOf(part)
    return (
      <Fragment key={part.id}>
        <ToolActionItem part={part} />
        {summary && <TestResultsBlock summary={summary} />}
      </Fragment>
    )
  })

  // Only the browser-tab chat still uses the badge in the header (there is no footer there);
  // in the main chat it comes out in the message footer — see diffInFooter.
  const diffBadge = showDiff && !working && (
    <DiffBadge patch={snapshot?.patch} authored={snapshot?.authored} parts={parts} sessionId={sessionId} messageId={messageId} />
  )

  if (flat) {
    return (
      <div className="not-prose my-2 flex w-full flex-col gap-1">
        <div className="flex w-full items-center gap-2 text-sm text-muted-foreground">
          {working ? <Shimmer>{title}</Shimmer> : <p className="text-sm">{title}</p>}
          {diffBadge && <div className="ml-auto">{diffBadge}</div>}
        </div>
        {items}
      </div>
    )
  }

  return (
    <Task open={open} onOpenChange={setOpen} className="not-prose my-2 w-full">
      <TaskTrigger title={title}>
        <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
          {working ? <Shimmer>{title}</Shimmer> : <p className="text-sm">{title}</p>}
          {/* The right corner belongs to the chevron: the badge, when it appears, enters next to
              it without disputing the `ml-auto`. */}
          <div className="ml-auto flex items-center gap-2">
            {diffBadge}
            <ChevronDownIcon
              className={cn("size-4 transition-transform", open ? "rotate-0" : "-rotate-90")}
            />
          </div>
        </div>
      </TaskTrigger>
      <TaskContent>
        {items}
        {hiddenCount > 0 && !showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            {t("chat.code.hiddenActions", { count: hiddenCount })}
          </button>
        )}
      </TaskContent>
    </Task>
  )
}

type Segment =
  | { kind: "task"; id: string; parts: ToolPart[] }
  | { kind: "image-group"; id: string; parts: ImagePart[] }
  | { kind: "part"; id: string; part: MessagePart }

function segmentParts(parts: MessagePart[], cardPart: (part: MessagePart) => boolean): Segment[] {
  const segments: Segment[] = []
  // One card per piece in the SAME message: `design_write` runs one screen per
  // call, and each one would leave another card of the same canvas. The first place
  // stays, with the state of the last call (it is the one that knows how many screens there are).
  const pieces = new Map<string, Extract<Segment, { kind: "part" }>>()
  for (const part of parts) {
    // Media that belongs to a piece: it stays as its own part to give way to its
    // card (an image with a card cannot become a thumbnail of a group).
    if (cardPart(part)) {
      segments.push({ kind: "part", id: part.id, part })
      continue
    }
    // Sub-agents, live TODO, skill and MCP connection proposals, show_image and
    // artifacts have their own render — the call does not enter the actions accordion (the
    // artifact card ALREADY is its result; the MCP one waits for a decision of yours)
    if (
      part.type === "tool" &&
      part.tool !== "subagent" &&
      part.tool !== "todowrite" &&
      part.tool !== "create_skill" &&
      part.tool !== "create_agent" &&
      part.tool !== "mcp_connect" &&
      part.tool !== "mcp_update" &&
      part.tool !== "show_image" &&
      part.tool !== "create_artifact" &&
      part.tool !== "update_artifact" &&
      part.tool !== "create_document" &&
      part.tool !== "update_document" &&
      // The pieces (motion, design, slides) have their own card, as in the chat —
      // closing the panel tab cannot take them out of sight.
      !isPieceCardTool(part.tool)
    ) {
      const last = segments[segments.length - 1]
      if (last?.kind === "task") last.parts.push(part)
      else segments.push({ kind: "task", id: part.id, parts: [part] })
    } else if (part.type === "image") {
      // Consecutive images (several at once, or the steps of a chained
      // edit) become a thumbnail strip — see ImageGroupView.
      const last = segments[segments.length - 1]
      if (last?.kind === "image-group") last.parts.push(part)
      else segments.push({ kind: "image-group", id: part.id, parts: [part] })
    } else {
      const segment = landPieceCard(pieces, part, (p) => ({ kind: "part" as const, id: p.id, part: p }))
      if (segment) segments.push(segment)
    }
  }
  return segments
}

export function CodeAssistantMessage({ message, sessionId, isLast, isBusy, busyLabel, onRetry, diffInFooter }: {
  message: ChatMessage
  sessionId?: string
  isLast: boolean
  isBusy: boolean
  /** Label of the waiting state (e.g. "Trying fallback 2/3…") — it replaces the default */
  busyLabel?: string
  onRetry?: () => void
  /** The "+N -N" badge comes out in the message footer (next to copy/speak/usage)
   *  instead of the actions header — see AssistantMessageActions. */
  diffInFooter?: boolean
}) {
  const { t } = useTranslation()
  const view = useSetting("chatView")
  // Media of a motion piece becomes its card, just like in chat mode.
  const indexes = useMotionBundleIndexes(sessionId)
  const plan = useMemo(
    () => planMotionBundles(message.parts, indexes, message.id),
    [message.parts, indexes, message.id],
  )
  const parts = useMemo(
    () => (plan.hidden.size ? message.parts.filter((part) => !plan.hidden.has(part.id)) : message.parts),
    [message.parts, plan],
  )
  const segments = useMemo(
    () =>
      segmentParts(
        arrangeForView(parts, view),
        // The routine proposal has its own card, like the pieces — without this
        // it would fall into the task group and the "create/discard" decision
        // would disappear.
        (part) => plan.cards.has(part.id) || isRoutineProposal(part),
      ),
    [parts, view, plan],
  )
  const flat = view === "detailed"
  const finished = !(isLast && isBusy)
  const sources = useMemo(() => (finished ? extractSources(message) : []), [finished, message])
  const waiting = isLast && isBusy && message.parts.length === 0

  // The LAST text block of the message is the final answer (white); the
  // previous ones are intermediate narration of the agent and stay in a faded color —
  // including if some action (read, bash etc.) arrives after the text in
  // the stream. A block is a run of consecutive text parts (lastTextRunStart):
  // two excerpts separated only by reasoning are the SAME answer — the case of
  // the cut by the token limit followed by AUTO_CONTINUE, in which the continuation
  // cannot erase the previous excerpt. Engine internal texts NEVER count
  // as the final answer nor break the run: they stay always faded, as
  // internal thought of the agent. 'nudge' = anti-overclaim check;
  // 'todo' = closing line of the checklist; 'internal' is the nudge that
  // ended as "nothing to fix" and does not even appear.
  const lastRunStart = useMemo(() => lastTextRunStart(segments), [segments])
  // The execution is written as a message: when its answer came as text, the routine-run part
  // is only metadata and draws nothing (it is the text that is read).
  const hasAnswerText = useMemo(
    () => message.parts.some((part) => part.type === "text" && !!part.text.trim()),
    [message.parts],
  )

  // Only the last todowrite is the live checklist; previous ones become a single line
  const lastTodoId = [...message.parts]
    .reverse()
    .find((p) => p.type === "tool" && p.tool === "todowrite")?.id

  return (
    <div className="flex w-full flex-col gap-1">
      {waiting && <Shimmer className="text-sm">{busyLabel ?? t("chat.code.analyzing")}</Shimmer>}
      {segments.map((segment, index) =>
        segment.kind === "task" ? (
          <TaskGroup
            key={segment.id}
            parts={segment.parts}
            snapshot={message.snapshot}
            sessionId={sessionId}
            messageId={message.id}
            live={isLast && isBusy}
            flat={flat}
            showDiff={!diffInFooter}
          />
        ) : segment.kind === "image-group" ? (
          <ImageGroupView key={segment.id} parts={segment.parts} />
        ) : plan.cards.has(segment.id) ? (
          <MotionBundleCard key={segment.id} bundle={plan.cards.get(segment.id)!} />
        ) : segment.part.type === "text" ? (
          segment.part.source === "internal" ? null : segment.part.source === "vision" ? (
            <VisionWorkingRow key={segment.id} />
          ) : (
            <AssistantMarkdown
              key={segment.id}
              sessionId={sessionId}
              muted={index < lastRunStart || isEngineText(segment.part.source)}
            >
              {segment.part.text}
            </AssistantMarkdown>
          )
        ) : segment.part.type === "reasoning" ? (
          <ReasoningPartView key={segment.id} part={segment.part} flat={flat} />
        ) : segment.part.type === "agent" ? (
          <AgentPartView key={segment.id} part={segment.part} />
        ) : segment.part.type === "routine-run" ? (
          <RoutineRunCard key={segment.id} part={segment.part} solo={!hasAnswerText} />
        ) : segment.part.type === "file" ? null : segment.part.type === "tool" && segment.part.tool === "subagent" ? (
          <SubAgentCard key={segment.id} part={segment.part} />
        ) : segment.part.type === "tool" && segment.part.tool === "todowrite" ? (
          <TodoList key={segment.id} part={segment.part} stale={segment.part.id !== lastTodoId} />
        ) : segment.part.type === "tool" && segment.part.tool === "create_skill" ? (
          <SkillProposalCard key={segment.id} part={segment.part} />
        ) : segment.part.type === "tool" && segment.part.tool === "create_agent" ? (
          <AgentProposalCard key={segment.id} part={segment.part} />
        ) : segment.part.type === "tool" && segment.part.tool === "routines_manage" ? (
          <RoutineProposalCard key={segment.id} part={segment.part} />
        ) : segment.part.type === "tool" &&
          (segment.part.tool === "mcp_connect" || segment.part.tool === "mcp_update") ? (
          <McpProposalCard key={segment.id} part={segment.part} />
        ) : segment.part.type === "artifact" ? (
          <ArtifactPartView key={segment.id} part={segment.part} sessionId={sessionId} />
        ) : segment.part.type === "document" ? (
          <DocumentPartView key={segment.id} part={segment.part} sessionId={sessionId} live={isLast && isBusy} />
        ) : segment.part.type === "audio" ? (
          <AudioPartView key={segment.id} part={segment.part} />
        ) : segment.part.type === "video" ? (
          <VideoPartView key={segment.id} part={segment.part} />
        ) : segment.part.type === "tool" && isPieceCardTool(segment.part.tool) ? (
          <PieceCardView key={segment.id} part={segment.part} sessionId={sessionId} />
        ) : null,
      )}
      {message.error && (
        // Redoing only makes sense in the LAST reply: the retry reruns the turn
        // over the user message, and in an old reply that would discard
        // what came after it.
        <MessageError
          sessionId={sessionId}
          error={message.error}
          kind={message.errorKind}
          attempts={message.attempts}
          failedModel={{ providerId: message.providerId, modelId: message.modelId }}
          onRetry={isLast ? onRetry : undefined}
        />
      )}
      {!message.error && message.truncated && <MessageTruncated />}
      {finished && sources.length > 0 && (
        <Sources className="mt-2">
          <SourcesTrigger count={sources.length}>
            <p className="font-medium">
              {t("chat.code.sourcesConsulted", { count: sources.length })}
            </p>
            <ChevronDownIcon className="h-4 w-4" />
          </SourcesTrigger>
          <SourcesContent>
            {sources.map((source) => (
              <Source href={source.url} key={source.url} title={source.title} />
            ))}
          </SourcesContent>
        </Sources>
      )}
    </div>
  )
}
