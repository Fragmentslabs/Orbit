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
import { MotionPartView } from "@/src/components/ai/motion-part"
import { Shimmer } from "@/src/components/ai/shimmer"
import { DiffBadge } from "@/src/components/messages/diff-badge"
import { SubAgentCard } from "@/src/components/ai/sub-agent-card"
import { TodoList } from "@/src/components/ai/todo-list"
import { McpProposalCard } from "@/src/components/mcp-proposal-card"
import { SkillProposalCard } from "@/src/components/skill-proposal-card"
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
 * Mensagem do assistente no modo código: ferramentas agrupadas em Tasks
 * (estilo agente), resultados de teste estruturados, reasoning e — no modo
 * plano com pesquisa — fontes consultadas.
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
  /** Modo detalhado: título e todas as ações abertas, sem acordeon. */
  flat?: boolean
  snapshot?: { patch?: string; files?: string[] }
  sessionId?: string
  messageId?: string
  /** Selo "+N -N" no cabeçalho do grupo. O chat principal o desliga: ali ele
   *  é renderizado no rodapé da mensagem, que fica sempre visível (ver
   *  DiffBadge e AssistantMessageActions). */
  showDiff?: boolean
  /** A mensagem é a última e o turno ainda está em streaming — só nesse caso
   *  uma part "running" é de verdade. Sem isto, uma mensagem antiga com uma
   *  tool-call que nunca recebeu resultado (abort, conexão caída) ficava
   *  mostrando "Working"/shimmer para sempre, mesmo fora de qualquer turno
   *  ativo — o chat-engine agora fecha essas parts ao salvar, mas uma
   *  mensagem já gravada quebrada antes desse fix se autocura aqui. */
  live: boolean
}) {
  const { t } = useTranslation()
  const working = live && parts.some((p) => p.state === "running")
  const errors = parts.filter((p) => p.state === "error").length
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const prevWorking = useRef(working)

  // Abre automaticamente enquanto trabalha
  useEffect(() => {
    if (working) setOpen(true)
  }, [working])

  // Auto-collapse 1s após o streaming terminar
  useEffect(() => {
    if (prevWorking.current && !working) {
      const timer = setTimeout(() => setOpen(false), 1000)
      return () => clearTimeout(timer)
    }
    prevWorking.current = working
  }, [working])

  // Tools visíveis: as MAX_VISIBLE últimas (ou todas se showAll)
  const visibleParts = showAll ? parts : parts.slice(-MAX_VISIBLE)
  const hiddenCount = parts.length - MAX_VISIBLE

  // Reseta showAll quando o grupo muda (nova mensagem)
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

  // Só o chat do browser-tab ainda usa o selo no cabeçalho (lá não há rodapé);
  // no chat principal ele sai no rodapé da mensagem — ver diffInFooter.
  const diffBadge = showDiff && !working && (
    <DiffBadge patch={snapshot?.patch} parts={parts} sessionId={sessionId} messageId={messageId} />
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
          {/* O canto direito é do chevron: o selo, quando aparece, entra ao lado
              dele sem disputar o `ml-auto`. */}
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

function segmentParts(parts: MessagePart[]): Segment[] {
  const segments: Segment[] = []
  for (const part of parts) {
    // Subagentes, TODO viva, propostas de skill e de conexão MCP, show_image e
    // artefatos têm render próprio — a chamada não entra no acordeon de ações (o
    // card do artefato JÁ é o resultado dela; o de MCP espera uma decisão sua)
    if (
      part.type === "tool" &&
      part.tool !== "subagent" &&
      part.tool !== "todowrite" &&
      part.tool !== "create_skill" &&
      part.tool !== "mcp_connect" &&
      part.tool !== "mcp_update" &&
      part.tool !== "show_image" &&
      part.tool !== "create_artifact" &&
      part.tool !== "update_artifact" &&
      part.tool !== "create_document" &&
      part.tool !== "update_document" &&
      // A peça de motion tem card próprio: sem ele, fechar a aba do painel era
      // perder a composição de vista — nada a listava na conversa.
      part.tool !== "motion_preview" &&
      part.tool !== "motion_write" &&
      part.tool !== "motion_edit"
    ) {
      const last = segments[segments.length - 1]
      if (last?.kind === "task") last.parts.push(part)
      else segments.push({ kind: "task", id: part.id, parts: [part] })
    } else if (part.type === "image") {
      // Imagens consecutivas (várias de uma vez, ou os passos de uma edição
      // em cadeia) viram uma tira de miniaturas — ver ImageGroupView.
      const last = segments[segments.length - 1]
      if (last?.kind === "image-group") last.parts.push(part)
      else segments.push({ kind: "image-group", id: part.id, parts: [part] })
    } else {
      segments.push({ kind: "part", id: part.id, part })
    }
  }
  return segments
}

export function CodeAssistantMessage({ message, sessionId, isLast, isBusy, busyLabel, onRetry, diffInFooter }: {
  message: ChatMessage
  sessionId?: string
  isLast: boolean
  isBusy: boolean
  /** Rótulo do estado de espera (ex.: "Tentando fallback 2/3…") — substitui o padrão */
  busyLabel?: string
  onRetry?: () => void
  /** O selo "+N -N" sai no rodapé da mensagem (junto de copiar/falar/gastos)
   *  em vez do cabeçalho das ações — ver AssistantMessageActions. */
  diffInFooter?: boolean
}) {
  const { t } = useTranslation()
  const view = useSetting("chatView")
  const segments = useMemo(() => segmentParts(arrangeForView(message.parts, view)), [message.parts, view])
  const flat = view === "detailed"
  const finished = !(isLast && isBusy)
  const sources = useMemo(() => (finished ? extractSources(message) : []), [finished, message])
  const waiting = isLast && isBusy && message.parts.length === 0

  // O ÚLTIMO bloco de texto da mensagem é a resposta final (branca); os
  // anteriores são narração intermediária do agente e ficam em cor apagada —
  // inclusive se alguma ação (read, bash etc.) chegar depois do texto no
  // stream. Um bloco é um run de partes consecutivas de texto (lastTextRunStart):
  // dois trechos separados só por reasoning são a MESMA resposta — caso do
  // corte por limite de tokens seguido de AUTO_CONTINUE, em que a continuação
  // não pode apagar o trecho anterior. Textos internos do engine NUNCA contam
  // como resposta final nem quebram o run: ficam sempre apagados, como
  // pensamento interno do agente. 'nudge' = verificação anti-overclaim;
  // 'todo' = linha de fechamento da checklist; 'internal' é o nudge que
  // terminou como "nada a corrigir" e nem aparece.
  const lastRunStart = useMemo(() => lastTextRunStart(segments), [segments])

  // Só a última todowrite é a checklist viva; anteriores viram uma linha
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
        ) : segment.part.type === "file" ? null : segment.part.type === "tool" && segment.part.tool === "subagent" ? (
          <SubAgentCard key={segment.id} part={segment.part} />
        ) : segment.part.type === "tool" && segment.part.tool === "todowrite" ? (
          <TodoList key={segment.id} part={segment.part} stale={segment.part.id !== lastTodoId} />
        ) : segment.part.type === "tool" && segment.part.tool === "create_skill" ? (
          <SkillProposalCard key={segment.id} part={segment.part} />
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
        ) : segment.part.type === "tool" &&
          (segment.part.tool === "motion_preview" ||
            segment.part.tool === "motion_write" ||
            segment.part.tool === "motion_edit") ? (
          <MotionPartView key={segment.id} part={segment.part} sessionId={sessionId} />
        ) : null,
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
