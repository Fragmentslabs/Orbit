import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { GlobeIcon, LinkIcon, SearchIcon, XCircleIcon } from "lucide-react"
import type { ChatMessage, ImagePart, MessagePart, ToolPart } from "@shared/chat"
import { extractSources, hostnameOf, isEngineText, lastTextRunStart, parseSearchResults, WEB_TOOLS } from "@/src/lib/message-utils"
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
import { ImageGroupView } from "@/src/components/ai/image"
import { ActionsGroup } from "@/src/components/ai/actions-group"
import { ArtifactPartView } from "@/src/components/ai/artifact-part"
import { DocumentPartView } from "@/src/components/ai/document-part"
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/src/components/ai/sources"
import { SkillProposalCard } from "@/src/components/skill-proposal-card"
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
 * Mensagem do assistente no modo chat: reasoning colapsável, pesquisa
 * renderizada como chain-of-thought, texto com citações inline e fontes
 * consultadas listadas ao final.
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

function ResearchBlock({ parts }: { parts: ToolPart[] }) {
  const { t } = useTranslation()
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

/** Agrupa as parts: ferramentas web consecutivas viram um único bloco de
 *  pesquisa; imagens consecutivas (várias pedidas de uma vez, ou os passos
 *  de uma edição em cadeia) viram uma tira de miniaturas em vez de N figuras
 *  em largura cheia empilhadas — ver ImageGroupView. */
type Segment =
  | { kind: "research"; id: string; parts: ToolPart[] }
  | { kind: "actions"; id: string; parts: ToolPart[] }
  | { kind: "image-group"; id: string; parts: ImagePart[] }
  | { kind: "part"; id: string; part: MessagePart }

/**
 * Ferramentas que NÃO entram no acordeon: o que elas produzem já tem um card
 * na conversa (o artefato, o documento, a imagem, o subagente), e repetir a
 * chamada ao lado do resultado é ruído. A proposta de skill e a checklist de
 * TODO são interativas — recolhê-las esconderia o que se espera que a pessoa
 * responda.
 */
const RENDER_PROPRIO = new Set([
  "subagent",
  "create_skill",
  "todowrite",
  "show_image",
  "create_artifact",
  "update_artifact",
  "create_document",
  "update_document",
])

function segmentParts(parts: MessagePart[]): Segment[] {
  const segments: Segment[] = []
  for (const part of parts) {
    if (part.type === "tool" && WEB_TOOLS.has(part.tool)) {
      const last = segments[segments.length - 1]
      if (last?.kind === "research") last.parts.push(part)
      else segments.push({ kind: "research", id: part.id, parts: [part] })
    } else if (part.type === "tool" && !RENDER_PROPRIO.has(part.tool)) {
      // Memória, documentos, imagem, esteira: ferramentas que interessam
      // ENQUANTO rodam e viram ruído depois. Uma linha só, como no código.
      const last = segments[segments.length - 1]
      if (last?.kind === "actions") last.parts.push(part)
      else segments.push({ kind: "actions", id: part.id, parts: [part] })
    } else if (part.type === "image") {
      const last = segments[segments.length - 1]
      if (last?.kind === "image-group") last.parts.push(part)
      else segments.push({ kind: "image-group", id: part.id, parts: [part] })
    } else {
      segments.push({ kind: "part", id: part.id, part })
    }
  }
  return segments
}

export function ChatAssistantMessage({ message, sessionId, isLast, isBusy, busyLabel, onRetry }: {
  message: ChatMessage
  sessionId?: string
  isLast: boolean
  isBusy: boolean
  /** Rótulo do estado de espera (ex.: "Tentando fallback 2/3…") — substitui "Pensando…" */
  busyLabel?: string
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  const segments = useMemo(() => segmentParts(message.parts), [message.parts])
  const finished = !(isLast && isBusy)
  const sources = useMemo(() => (finished ? extractSources(message) : []), [finished, message])
  const waiting = isLast && isBusy && message.parts.length === 0

  // O ÚLTIMO bloco de texto da mensagem é a resposta final (branca); os
  // anteriores são narração intermediária ("pensando alto") e ficam em cor
  // apagada — inclusive se alguma ferramenta (pesquisa, agente etc.) chegar
  // depois do texto no stream. Um bloco é um run de partes consecutivas de
  // texto (lastTextRunStart): dois trechos separados só por reasoning são a
  // MESMA resposta — caso do corte por limite de tokens seguido de
  // AUTO_CONTINUE. Textos do engine NUNCA contam como resposta final nem
  // quebram o run: 'nudge' (verificação anti-overclaim) e 'todo' (fechamento
  // da checklist) ficam apagados; 'internal' ("nada a corrigir") não
  // renderiza.
  const lastRunStart = useMemo(() => lastTextRunStart(segments), [segments])

  return (
    <div className="flex w-full flex-col gap-1">
      {waiting && <Shimmer className="text-sm">{busyLabel ?? t("chat.thinking")}</Shimmer>}
      {segments.map((segment, index) =>
        segment.kind === "research" ? (
          <ResearchBlock key={segment.id} parts={segment.parts} />
        ) : segment.kind === "actions" ? (
          <ActionsGroup key={segment.id} parts={segment.parts} />
        ) : segment.kind === "image-group" ? (
          <ImageGroupView key={segment.id} parts={segment.parts} />
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
          <ReasoningPartView key={segment.id} part={segment.part} />
        ) : segment.part.type === "agent" ? (
          <AgentPartView key={segment.id} part={segment.part} />
        ) : segment.part.type === "artifact" ? (
          <ArtifactPartView key={segment.id} part={segment.part} sessionId={sessionId} />
        ) : segment.part.type === "document" ? (
          <DocumentPartView key={segment.id} part={segment.part} sessionId={sessionId} live={isLast && isBusy} />
        ) : segment.part.type === "file" ? null : segment.part.type === "image" ? (
          // Nunca acontece de fato — segmentParts sempre roteia "image" para
          // um segmento "image-group" — mas o TS não sabe disso estaticamente.
          null
        ) : segment.part.tool === "subagent" ? (
          <SubAgentCard key={segment.id} part={segment.part} />
        ) : segment.part.tool === "create_skill" ? (
          <SkillProposalCard key={segment.id} part={segment.part} />
        ) : // O card do artefato já é o resultado destas tools — o chip genérico
        // ao lado dele seria ruído
        segment.part.tool === "show_image" ||
          segment.part.tool === "create_artifact" ||
          segment.part.tool === "update_artifact" ||
          segment.part.tool === "create_document" ||
          segment.part.tool === "update_document" ? null : (
          <GenericToolView
            key={segment.id}
            part={segment.part}
            label={segment.part.tool}
            subtitle={
              typeof segment.part.input?.command === "string" ? segment.part.input.command : undefined
            }
          />
        ),
      )}
      {message.error && (
        <MessageError
          sessionId={sessionId}
          error={message.error}
          kind={message.errorKind}
          attempts={message.attempts}
          failedModel={{ providerId: message.providerId, modelId: message.modelId }}
          onRetry={onRetry}
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
