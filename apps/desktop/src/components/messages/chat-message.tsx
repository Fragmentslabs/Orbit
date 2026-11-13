import { useEffect, useMemo, useState } from "react"
import { AudioPartView } from "@/src/components/messages/audio-part"
import { VideoPartView } from "@/src/components/messages/video-part"
import { useTranslation } from "react-i18next"
import { GlobeIcon, LinkIcon, SearchIcon, XCircleIcon } from "lucide-react"
import type { ChatMessage, ImagePart, MessagePart, ToolPart } from "@shared/chat"
import { arrangeForView, extractSources, hostnameOf, isEngineText, lastTextRunStart, parseSearchResults, WEB_TOOLS } from "@/src/lib/message-utils"
import { useSetting } from "@/src/stores/app-settings"
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "@/src/components/ai/chain-of-thought"
import { Shimmer } from "@/src/components/ai/shimmer"
import { MotionBundleCard } from "@/src/components/messages/motion-bundle-card"
import { planMotionBundles } from "@/src/lib/motion-bundle"
import { useMotionBundleIndexes } from "@/src/stores/motion-bundles-store"
import { DESIGN_CARD_TOOLS, FRAGMENT_CARD_TOOLS, MOTION_CARD_TOOLS, SLIDES_CARD_TOOLS, isPieceCardTool, landPieceCard } from "@/src/lib/piece-tools"
import { PieceCardView } from "@/src/components/ai/piece-card-view"
import { SubAgentCard } from "@/src/components/ai/sub-agent-card"
import { ImageGroupView } from "@/src/components/ai/image"
import { ActionsGroup } from "@/src/components/ai/actions-group"
import { ArtifactPartView } from "@/src/components/ai/artifact-part"
import { DocumentPartView } from "@/src/components/ai/document-part"
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/src/components/ai/sources"
import { McpProposalCard } from "@/src/components/mcp-proposal-card"
import { AgentProposalCard } from "@/src/components/agent-proposal-card"
import { SkillProposalCard } from "@/src/components/skill-proposal-card"
import { isRoutineProposal, RoutineProposalCard } from "@/src/components/routines/routine-proposal-card"
import { RoutineRunCard } from "@/src/components/routines/run-card"
import {
  AgentPartView,
  AssistantMarkdown,
  GenericToolView,
  MessageError,
  MessageTruncated,
  ReasoningPartView,
  VisionWorkingRow,
} from "@/src/components/messages/shared"

/**
 * Assistant message in chat mode: collapsible reasoning, research
 * rendered as chain-of-thought, text with inline citations and consulted
 * sources listed at the end.
 */

function useStepLabels(): Record<string, string> {
  const { t } = useTranslation()
  return {
    websearch: t("chat.steps.websearch"),
    webfetch: t("chat.steps.webfetch"),
    browser_open: t("chat.steps.browser_open"),
    browser_links: t("chat.steps.browser_links"),
  }
}

function stepInfo(part: ToolPart, stepLabels: Record<string, string>) {
  const input = part.input ?? {}
  const query = typeof input.query === "string" ? input.query : undefined
  const url = typeof input.url === "string" ? hostnameOf(input.url) : undefined
  const base = stepLabels[part.tool] ?? part.tool
  return {
    icon: part.tool === "websearch" ? SearchIcon : GlobeIcon,
    label: query ? `${base} "${query}"` : url ? `${base} ${url}` : base,
  }
}

function ResearchStep({ part }: { part: ToolPart }) {
  const stepLabels = useStepLabels()
  const { icon, label } = stepInfo(part, stepLabels)
  const results = part.tool === "websearch" && part.output ? parseSearchResults(part.output) : []

  return (
    <ChainOfThoughtStep
      icon={part.state === "error" ? XCircleIcon : icon}
      label={part.state === "running" ? <Shimmer>{label}</Shimmer> : label}
      description={part.state === "error" ? part.error : undefined}
      status={part.state === "running" ? "active" : "complete"}
    >
      {results.length > 0 && (
        <ChainOfThoughtSearchResults>
          {results.slice(0, 6).map((result) => (
            <ChainOfThoughtSearchResult key={result.url}>
              <LinkIcon className="size-3" />
              {hostnameOf(result.url)}
            </ChainOfThoughtSearchResult>
          ))}
        </ChainOfThoughtSearchResults>
      )}
    </ChainOfThoughtStep>
  )
}

function ResearchBlock({ parts, flat }: { parts: ToolPart[]; flat?: boolean }) {
  const { t } = useTranslation()
  const researching = parts.some((p) => p.state === "running")
  const [open, setOpen] = useState(researching)

  // Opens automatically while researching and collapses on completion
  useEffect(() => {
    setOpen(researching)
  }, [researching])

  return (
    // Detailed mode: the chain of steps stays always open.
    <ChainOfThought open={flat || open} onOpenChange={setOpen} className="my-2">
      <ChainOfThoughtHeader>
        {researching ? (
          <Shimmer>{t("chat.researching")}</Shimmer>
        ) : (
          t("chat.researchDone", { count: parts.length })
        )}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {parts.map((part) => (
          <ResearchStep key={part.id} part={part} />
        ))}
      </ChainOfThoughtContent>
    </ChainOfThought>
  )
}

/** Groups the parts: consecutive web tools become a single research
 *  block; consecutive images (several asked for at once, or the steps
 *  of a chained edit) become a thumbnail strip instead of N full-width
 *  figures stacked — see ImageGroupView. */
type Segment =
  | { kind: "research"; id: string; parts: ToolPart[] }
  | { kind: "actions"; id: string; parts: ToolPart[] }
  | { kind: "image-group"; id: string; parts: ImagePart[] }
  | { kind: "part"; id: string; part: MessagePart }

/**
 * Tools that do NOT enter the accordion: what they produce already has a card
 * in the conversation (the artifact, the document, the image, the sub-agent), and repeating the
 * call next to the result is noise. The skill proposal and the TODO
 * checklist are interactive — collapsing them would hide what the person is expected
 * to answer.
 */
const RENDER_PROPRIO = new Set([
  "subagent",
  "create_skill",
  "create_agent",
  // MCP connection and a user decision in the card — just like the skill proposal.
  "mcp_connect",
  "mcp_update",
  "todowrite",
  "show_image",
  "create_artifact",
  "update_artifact",
  "create_document",
  "update_document",
  // The pieces (motion, design, slides) have their own card — see piece-tools.ts.
  ...MOTION_CARD_TOOLS,
  ...DESIGN_CARD_TOOLS,
  ...SLIDES_CARD_TOOLS,
  ...FRAGMENT_CARD_TOOLS,
])

/**
 * `cardPart`: parts that give way to the piece card. They do not enter the
 * grouping (an image with a card cannot become a thumbnail of a group — the
 * card is what speaks for the piece).
 */
function segmentParts(parts: MessagePart[], cardPart: (part: MessagePart) => boolean): Segment[] {
  const segments: Segment[] = []
  // One card per piece in the SAME message: `design_write` runs one screen per
  // call, and each one would leave another card of the same canvas. The first place
  // stays, with the state of the last call (it is the one that knows how many screens there are).
  const pieces = new Map<string, Extract<Segment, { kind: "part" }>>()
  for (const part of parts) {
    if (cardPart(part)) {
      segments.push({ kind: "part", id: part.id, part })
    } else if (part.type === "tool" && WEB_TOOLS.has(part.tool)) {
      const last = segments[segments.length - 1]
      if (last?.kind === "research") last.parts.push(part)
      else segments.push({ kind: "research", id: part.id, parts: [part] })
    } else if (part.type === "tool" && !RENDER_PROPRIO.has(part.tool)) {
      // Memory, documents, image, pipeline: tools that matter
      // WHILE they run and become noise afterwards. A single line, as in the code.
      const last = segments[segments.length - 1]
      if (last?.kind === "actions") last.parts.push(part)
      else segments.push({ kind: "actions", id: part.id, parts: [part] })
    } else if (part.type === "image") {
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

export function ChatAssistantMessage({ message, sessionId, isLast, isBusy, busyLabel, onRetry }: {
  message: ChatMessage
  sessionId?: string
  isLast: boolean
  isBusy: boolean
  /** Label of the waiting state (e.g. "Trying fallback 2/3…") — it replaces "Thinking…" */
  busyLabel?: string
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  const view = useSetting("chatView")
  // Media that belongs to a PIECE becomes the piece card, not a loose player — see
  // planMotionBundles. What the composition does not use stays listed in the card.
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
        // it would fall into the action accordion and the "create/discard"
        // decision would disappear.
        (part) => plan.cards.has(part.id) || isRoutineProposal(part),
      ),
    [parts, view, plan],
  )
  const flat = view === "detailed"
  const finished = !(isLast && isBusy)
  const sources = useMemo(() => (finished ? extractSources(message) : []), [finished, message])
  const waiting = isLast && isBusy && message.parts.length === 0

  // The LAST text block of the message is the final answer (white); the
  // previous ones are intermediate narration ("thinking out loud") and stay in a
  // faded color — including if some tool (research, agent etc.) arrives
  // after the text in the stream. A block is a run of consecutive text
  // parts (lastTextRunStart): two excerpts separated only by reasoning are the
  // SAME answer — the case of the cut by the token limit followed by
  // AUTO_CONTINUE. Engine texts NEVER count as the final answer nor
  // break the run: 'nudge' (anti-overclaim check) and 'todo' (closing
  // of the checklist) stay faded; 'internal' ("nothing to fix") does not
  // render.
  const lastRunStart = useMemo(() => lastTextRunStart(segments), [segments])
  // The execution is written as a message: when its answer came as text, the routine-run part
  // is only metadata and draws nothing (it is the text that is read).
  const hasAnswerText = useMemo(
    () => message.parts.some((part) => part.type === "text" && !!part.text.trim()),
    [message.parts],
  )

  return (
    <div className="flex w-full flex-col gap-1">
      {waiting && <Shimmer className="text-sm">{busyLabel ?? t("chat.thinking")}</Shimmer>}
      {segments.map((segment, index) =>
        segment.kind === "research" ? (
          <ResearchBlock key={segment.id} parts={segment.parts} flat={flat} />
        ) : segment.kind === "actions" ? (
          <ActionsGroup key={segment.id} parts={segment.parts} flat={flat} />
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
        ) : segment.part.type === "artifact" ? (
          <ArtifactPartView key={segment.id} part={segment.part} sessionId={sessionId} />
        ) : segment.part.type === "document" ? (
          <DocumentPartView key={segment.id} part={segment.part} sessionId={sessionId} live={isLast && isBusy} />
        ) : segment.part.type === "audio" ? (
          <AudioPartView key={segment.id} part={segment.part} />
        ) : segment.part.type === "video" ? (
          <VideoPartView key={segment.id} part={segment.part} />
        ) : segment.part.type === "routine-run" ? (
          <RoutineRunCard key={segment.id} part={segment.part} solo={!hasAnswerText} />
        ) : segment.part.type === "file" ? null : segment.part.type === "image" ? (
          // It never happens in fact — segmentParts always routes "image" to
          // an "image-group" segment — but TS does not know that statically.
          null
        ) : segment.part.tool === "subagent" ? (
          <SubAgentCard key={segment.id} part={segment.part} />
        ) : segment.part.tool === "create_skill" ? (
          <SkillProposalCard key={segment.id} part={segment.part} />
        ) : segment.part.tool === "create_agent" ? (
          <AgentProposalCard key={segment.id} part={segment.part} />
        ) : segment.part.tool === "routines_manage" ? (
          <RoutineProposalCard key={segment.id} part={segment.part} />
        ) : isPieceCardTool(segment.part.tool) ? (
          <PieceCardView key={segment.id} part={segment.part} sessionId={sessionId} />
        ) : segment.part.tool === "mcp_connect" || segment.part.tool === "mcp_update" ? (
          <McpProposalCard key={segment.id} part={segment.part} />
        ) : // The artifact card already is the result of these tools — the generic chip
        // next to it would be noise
        segment.part.tool === "show_image" ||
          segment.part.tool === "create_artifact" ||
          segment.part.tool === "update_artifact" ||
          segment.part.tool === "create_document" ||
          segment.part.tool === "update_document" ? null : (
          <GenericToolView
            key={segment.id}
            part={segment.part}
            label={segment.part.tool}
            sessionId={sessionId}
            subtitle={
              typeof segment.part.input?.command === "string" ? segment.part.input.command : undefined
            }
          />
        ),
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
          <SourcesTrigger count={sources.length} />
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
