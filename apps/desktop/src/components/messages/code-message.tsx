import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ChatMessage, MessagePart, ToolPart } from "@shared/chat"
import { usePanelStore } from "@/src/stores/panel-store"
import {
  extractSources,
  isTestCommand,
  parseTestSummary,
  type TestSummary,
} from "@/src/lib/message-utils"
import { ImagePartView } from "@/src/components/ai/image"
import { Shimmer } from "@/src/components/ai/shimmer"
import { SubAgentCard } from "@/src/components/ai/sub-agent-card"
import { TodoList } from "@/src/components/ai/todo-list"
import { SkillProposalCard } from "@/src/components/skill-proposal-card"
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/src/components/ai/sources"
import { Task, TaskContent, TaskItem, TaskItemFile, TaskTrigger } from "@/src/components/ai/task"
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
} from "@/src/components/messages/shared"

/**
 * Mensagem do assistente no modo código: ferramentas agrupadas em Tasks
 * (estilo agente), resultados de teste estruturados, reasoning e — no modo
 * plano com pesquisa — fontes consultadas.
 */

function useActionLabels(): Record<string, string> {
  const { t } = useTranslation()
  return {
    read: t("chat.actions.read"),
    write: t("chat.actions.write"),
    edit: t("chat.actions.edit"),
    ls: t("chat.actions.ls"),
    glob: t("chat.actions.glob"),
    grep: t("chat.actions.grep"),
    bash: t("chat.actions.bash"),
    websearch: t("chat.actions.websearch"),
    webfetch: t("chat.actions.webfetch"),
  }
}

function toolChip(part: ToolPart): string | undefined {
  const input = part.input ?? {}
  const candidate = input.filePath ?? input.dirPath ?? input.pattern ?? input.query ?? input.url ?? input.command
  if (typeof candidate !== "string" || !candidate) return undefined
  // Para caminhos, mostra só o nome do arquivo/última pasta
  const isPath = typeof input.filePath === "string" || typeof input.dirPath === "string"
  return isPath ? candidate.split(/[\\/]/).pop() : candidate
}

function testSummaryOf(part: ToolPart): TestSummary | null {
  if (part.tool !== "bash" || part.state !== "done" || !part.output) return null
  const command = typeof part.input?.command === "string" ? part.input.command : ""
  if (!isTestCommand(command)) return null
  return parseTestSummary(part.output)
}

function ToolActionItem({ part }: { part: ToolPart }) {
  const [showOutput, setShowOutput] = useState(false)
  const actionLabels = useActionLabels()
  const label = actionLabels[part.tool] ?? part.tool
  const chip = toolChip(part)
  const detail = part.error ?? (part.tool === "bash" ? part.output : undefined)

  return (
    <TaskItem>
      <button
        type="button"
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 text-left",
          detail && "cursor-pointer hover:text-foreground",
          part.state === "error" && "text-destructive",
        )}
        onClick={() => detail && setShowOutput((v) => !v)}
      >
        {part.state === "running" ? <Shimmer>{label}</Shimmer> : <span>{label}</span>}
        {chip && (
          <TaskItemFile>
            <span className="max-w-64 truncate font-mono">{chip}</span>
          </TaskItemFile>
        )}
        {detail && (
          <ChevronDownIcon
            className={cn("size-3 shrink-0 transition-transform", showOutput && "rotate-180")}
          />
        )}
      </button>
      {showOutput && detail && (
        <pre className="mt-1 max-h-56 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {detail}
        </pre>
      )}
    </TaskItem>
  )
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

function TaskGroup({ parts, snapshot, sessionId, messageId }: {
  parts: ToolPart[]
  snapshot?: { patch?: string; files?: string[] }
  sessionId?: string
  messageId?: string
}) {
  const { t } = useTranslation()
  const working = parts.some((p) => p.state === "running")
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

  // Conta +/- do snapshot se disponível
  const diffCounts = useMemo(() => {
    if (!snapshot?.patch) return null
    let added = 0
    let removed = 0
    for (const line of snapshot.patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++
      else if (line.startsWith("-") && !line.startsWith("---")) removed++
    }
    return { added, removed }
  }, [snapshot?.patch])

  const hasFileOps = parts.some((p) => p.tool === "write" || p.tool === "edit")
  const showBadge = !working && diffCounts && hasFileOps && sessionId && messageId

  const handleOpenDiff = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (sessionId && messageId) {
      usePanelStore.getState().openDiff(sessionId, messageId, "Diff")
    }
  }, [sessionId, messageId])

  const title = working
    ? t("chat.code.working")
    : errors > 0
      ? t("chat.code.actionsWithError", { count: parts.length, errors })
      : t("chat.code.actionsDone", { count: parts.length })

  return (
    <Task open={open} onOpenChange={setOpen} className="not-prose my-2 w-full">
      <TaskTrigger title={title}>
        <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
          {working ? <Shimmer>{title}</Shimmer> : <p className="text-sm">{title}</p>}
          {showBadge && (
            <button
              type="button"
              onClick={handleOpenDiff}
              className="ml-auto flex items-center gap-1 rounded-md border border-border/50 px-1.5 py-0.5 font-mono text-[11px] leading-none transition-colors hover:bg-accent"
            >
              {diffCounts!.added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{diffCounts!.added}</span>}
              {diffCounts!.removed > 0 && <span className="text-red-600 dark:text-red-400">-{diffCounts!.removed}</span>}
            </button>
          )}
          <ChevronDownIcon
            className={cn("size-4 transition-transform", open ? "rotate-0" : "-rotate-90")}
          />
        </div>
      </TaskTrigger>
      <TaskContent>
        {visibleParts.map((part) => {
          const summary = testSummaryOf(part)
          return (
            <Fragment key={part.id}>
              <ToolActionItem part={part} />
              {summary && <TestResultsBlock summary={summary} />}
            </Fragment>
          )
        })}
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
  | { kind: "part"; id: string; part: MessagePart }

function segmentParts(parts: MessagePart[]): Segment[] {
  const segments: Segment[] = []
  for (const part of parts) {
    // Subagentes, TODO viva, propostas de skill e show_image têm render próprio
    if (
      part.type === "tool" &&
      part.tool !== "subagent" &&
      part.tool !== "todowrite" &&
      part.tool !== "create_skill" &&
      part.tool !== "show_image"
    ) {
      const last = segments[segments.length - 1]
      if (last?.kind === "task") last.parts.push(part)
      else segments.push({ kind: "task", id: part.id, parts: [part] })
    } else {
      segments.push({ kind: "part", id: part.id, part })
    }
  }
  return segments
}

export function CodeAssistantMessage({ message, sessionId, isLast, isBusy, onRetry }: {
  message: ChatMessage
  sessionId?: string
  isLast: boolean
  isBusy: boolean
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  const segments = useMemo(() => segmentParts(message.parts), [message.parts])
  const finished = !(isLast && isBusy)
  const sources = useMemo(() => (finished ? extractSources(message) : []), [finished, message])
  const waiting = isLast && isBusy && message.parts.length === 0

  // Só o último texto da mensagem é a resposta final (branca); os anteriores
  // são narração intermediária do agente e ficam em cor apagada — inclusive
  // se alguma ação (read, bash etc.) chegar depois do texto final no stream.
  const lastTextIndex = segments.reduce(
    (last, segment, i) => (segment.kind === "part" && segment.part.type === "text" ? i : last),
    -1,
  )

  // Só a última todowrite é a checklist viva; anteriores viram uma linha
  const lastTodoId = [...message.parts]
    .reverse()
    .find((p) => p.type === "tool" && p.tool === "todowrite")?.id

  return (
    <div className="flex w-full flex-col gap-1">
      {waiting && <Shimmer className="text-sm">{t("chat.code.analyzing")}</Shimmer>}
      {segments.map((segment, index) =>
        segment.kind === "task" ? (
          <TaskGroup
            key={segment.id}
            parts={segment.parts}
            snapshot={message.snapshot}
            sessionId={sessionId}
            messageId={message.id}
          />
        ) : segment.part.type === "text" ? (
          <AssistantMarkdown key={segment.id} muted={index < lastTextIndex}>
            {segment.part.text}
          </AssistantMarkdown>
        ) : segment.part.type === "reasoning" ? (
          <ReasoningPartView key={segment.id} part={segment.part} />
        ) : segment.part.type === "agent" ? (
          <AgentPartView key={segment.id} part={segment.part} />
        ) : segment.part.type === "file" ? null : segment.part.type === "tool" && segment.part.tool === "subagent" ? (
          <SubAgentCard key={segment.id} part={segment.part} />
        ) : segment.part.type === "tool" && segment.part.tool === "todowrite" ? (
          <TodoList key={segment.id} part={segment.part} stale={segment.part.id !== lastTodoId} />
        ) : segment.part.type === "tool" && segment.part.tool === "create_skill" ? (
          <SkillProposalCard key={segment.id} part={segment.part} />
        ) : segment.part.type === "image" ? (
          <ImagePartView key={segment.id} part={segment.part} />
        ) : null,
      )}
      {message.error && (
        <MessageError
          sessionId={sessionId}
          error={message.error}
          kind={message.errorKind}
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
