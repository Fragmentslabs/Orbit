import { useEffect, useMemo, useState } from "react"
import { GlobeIcon, LinkIcon, SearchIcon, XCircleIcon } from "lucide-react"
import type { ChatMessage, MessagePart, ToolPart } from "@shared/chat"
import { extractSources, hostnameOf, parseSearchResults, WEB_TOOLS } from "@/src/lib/message-utils"
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "@/src/components/ai/chain-of-thought"
import { Shimmer } from "@/src/components/ai/shimmer"
import { SubAgentCard } from "@/src/components/ai/sub-agent-card"
import { ImagePartView } from "@/src/components/ai/image"
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/src/components/ai/sources"
import { SkillProposalCard } from "@/src/components/skill-proposal-card"
import {
  AgentPartView,
  AssistantMarkdown,
  GenericToolView,
  MessageError,
  MessageTruncated,
  ReasoningPartView,
} from "@/src/components/messages/shared"

/**
 * Mensagem do assistente no modo chat: reasoning colapsável, pesquisa
 * renderizada como chain-of-thought, texto com citações inline e fontes
 * consultadas listadas ao final.
 */

const STEP_LABELS: Record<string, string> = {
  websearch: "Pesquisando",
  webfetch: "Lendo página",
  browser_open: "Navegando",
  browser_links: "Coletando links",
}

function stepInfo(part: ToolPart) {
  const input = part.input ?? {}
  const query = typeof input.query === "string" ? input.query : undefined
  const url = typeof input.url === "string" ? hostnameOf(input.url) : undefined
  const base = STEP_LABELS[part.tool] ?? part.tool
  return {
    icon: part.tool === "websearch" ? SearchIcon : GlobeIcon,
    label: query ? `${base} "${query}"` : url ? `${base} ${url}` : base,
  }
}

function ResearchStep({ part }: { part: ToolPart }) {
  const { icon, label } = stepInfo(part)
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

function ResearchBlock({ parts }: { parts: ToolPart[] }) {
  const researching = parts.some((p) => p.state === "running")
  const [open, setOpen] = useState(researching)

  // Abre automaticamente enquanto pesquisa e recolhe ao concluir
  useEffect(() => {
    setOpen(researching)
  }, [researching])

  return (
    <ChainOfThought open={open} onOpenChange={setOpen} className="my-2">
      <ChainOfThoughtHeader>
        {researching ? (
          <Shimmer>Pesquisando…</Shimmer>
        ) : (
          `Pesquisa concluída · ${parts.length} ${parts.length === 1 ? "etapa" : "etapas"}`
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

/** Agrupa as parts: ferramentas web consecutivas viram um único bloco de pesquisa. */
type Segment =
  | { kind: "research"; id: string; parts: ToolPart[] }
  | { kind: "part"; id: string; part: MessagePart }

function segmentParts(parts: MessagePart[]): Segment[] {
  const segments: Segment[] = []
  for (const part of parts) {
    if (part.type === "tool" && WEB_TOOLS.has(part.tool)) {
      const last = segments[segments.length - 1]
      if (last?.kind === "research") last.parts.push(part)
      else segments.push({ kind: "research", id: part.id, parts: [part] })
    } else {
      segments.push({ kind: "part", id: part.id, part })
    }
  }
  return segments
}

export function ChatAssistantMessage({ message, isLast, isBusy, onRetry }: {
  message: ChatMessage
  isLast: boolean
  isBusy: boolean
  onRetry?: () => void
}) {
  const segments = useMemo(() => segmentParts(message.parts), [message.parts])
  const finished = !(isLast && isBusy)
  const sources = useMemo(() => (finished ? extractSources(message) : []), [finished, message])
  const waiting = isLast && isBusy && message.parts.length === 0

  // Texto seguido de ferramentas é narração intermediária ("pensando alto"),
  // não a resposta final — renderiza em cor apagada.
  const lastToolIndex = segments.reduce(
    (last, segment, i) => (segment.kind === "research" ? i : last),
    -1,
  )

  return (
    <div className="flex w-full flex-col gap-1">
      {waiting && <Shimmer className="text-sm">Pensando…</Shimmer>}
      {segments.map((segment, index) =>
        segment.kind === "research" ? (
          <ResearchBlock key={segment.id} parts={segment.parts} />
        ) : segment.part.type === "text" ? (
          <AssistantMarkdown key={segment.id} muted={index < lastToolIndex}>
            {segment.part.text}
          </AssistantMarkdown>
        ) : segment.part.type === "reasoning" ? (
          <ReasoningPartView key={segment.id} part={segment.part} />
        ) : segment.part.type === "image" ? (
          <ImagePartView key={segment.id} part={segment.part} />
        ) : segment.part.type === "agent" ? (
          <AgentPartView key={segment.id} part={segment.part} />
        ) : segment.part.type === "file" ? null : segment.part.tool === "subagent" ? (
          <SubAgentCard key={segment.id} part={segment.part} />
        ) : segment.part.tool === "create_skill" ? (
          <SkillProposalCard key={segment.id} part={segment.part} />
        ) : segment.part.tool === "show_image" ? null : (
          <GenericToolView key={segment.id} part={segment.part} label={segment.part.tool} />
        ),
      )}
      {message.error && <MessageError error={message.error} onRetry={onRetry} />}
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
