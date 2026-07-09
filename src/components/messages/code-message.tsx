import { Fragment, useEffect, useMemo, useState } from "react"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ChatMessage, MessagePart, ToolPart } from "@/shared/chat"
import {
  extractSources,
  isTestCommand,
  parseTestSummary,
  type TestSummary,
} from "@/src/lib/message-utils"
import { Shimmer } from "@/src/components/ai/shimmer"
import { SubAgentCard } from "@/src/components/ai/sub-agent-card"
import { TodoList } from "@/src/components/ai/todo-list"
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/src/components/ai/sources"
import { Task, TaskContent, TaskItem, TaskItemFile, TaskTrigger } from "@/src/components/ai/task"
import {
  TestResults,
  TestResultsHeader,
  TestResultsProgress,
  TestResultsSummary,
} from "@/src/components/ai/test-results"
import {
  AssistantMarkdown,
  MessageError,
  ReasoningPartView,
} from "@/src/components/messages/shared"

/**
 * Mensagem do assistente no modo código: ferramentas agrupadas em Tasks
 * (estilo agente), resultados de teste estruturados, reasoning e — no modo
 * plano com pesquisa — fontes consultadas.
 */

const ACTION_LABELS: Record<string, string> = {
  read: "Lendo",
  write: "Escrevendo",
  edit: "Editando",
  ls: "Listando",
  glob: "Buscando arquivos",
  grep: "Procurando",
  bash: "Executando",
  websearch: "Pesquisando",
  webfetch: "Lendo página",
}

function fileChip(part: ToolPart): string | undefined {
  const input = part.input ?? {}
  const candidate = input.filePath ?? input.dirPath ?? input.pattern ?? input.query ?? input.url
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
  const label = ACTION_LABELS[part.tool] ?? part.tool
  const chip = fileChip(part)
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

function TaskGroup({ parts }: { parts: ToolPart[] }) {
  const working = parts.some((p) => p.state === "running")
  const errors = parts.filter((p) => p.state === "error").length
  const [open, setOpen] = useState(false)

  // Abre automaticamente enquanto trabalha; fica fechado por padrão ao concluir
  useEffect(() => {
    if (working) setOpen(true)
  }, [working])

  const title = working
    ? "Trabalhando…"
    : errors > 0
      ? `${parts.length} ${parts.length === 1 ? "ação" : "ações"} · ${errors} com erro`
      : `${parts.length} ${parts.length === 1 ? "ação executada" : "ações executadas"}`

  return (
    <Task open={open} onOpenChange={setOpen} className="not-prose my-2 w-full">
      <TaskTrigger title={title}>
        <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
          {working ? <Shimmer>{title}</Shimmer> : <p className="text-sm">{title}</p>}
          <ChevronDownIcon
            className={cn("size-4 transition-transform", open ? "rotate-0" : "-rotate-90")}
          />
        </div>
      </TaskTrigger>
      <TaskContent>
        {parts.map((part) => {
          const summary = testSummaryOf(part)
          return (
            <Fragment key={part.id}>
              <ToolActionItem part={part} />
              {summary && <TestResultsBlock summary={summary} />}
            </Fragment>
          )
        })}
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
    // Subagentes e a TODO viva têm cards próprios — fora do agrupamento de Task
    if (part.type === "tool" && part.tool !== "subagent" && part.tool !== "todowrite") {
      const last = segments[segments.length - 1]
      if (last?.kind === "task") last.parts.push(part)
      else segments.push({ kind: "task", id: part.id, parts: [part] })
    } else {
      segments.push({ kind: "part", id: part.id, part })
    }
  }
  return segments
}

export function CodeAssistantMessage({ message, isLast, isBusy }: {
  message: ChatMessage
  isLast: boolean
  isBusy: boolean
}) {
  const segments = useMemo(() => segmentParts(message.parts), [message.parts])
  const finished = !(isLast && isBusy)
  const sources = useMemo(() => (finished ? extractSources(message) : []), [finished, message])
  const waiting = isLast && isBusy && message.parts.length === 0

  // Texto seguido de ações é narração intermediária do agente, não a
  // resposta final — renderiza em cor apagada.
  const lastTaskIndex = segments.reduce(
    (last, segment, i) => (segment.kind === "task" ? i : last),
    -1,
  )

  // Só a última todowrite é a checklist viva; anteriores viram uma linha
  const lastTodoId = [...message.parts]
    .reverse()
    .find((p) => p.type === "tool" && p.tool === "todowrite")?.id

  return (
    <div className="flex w-full flex-col gap-1">
      {waiting && <Shimmer className="text-sm">Analisando…</Shimmer>}
      {segments.map((segment, index) =>
        segment.kind === "task" ? (
          <TaskGroup key={segment.id} parts={segment.parts} />
        ) : segment.part.type === "text" ? (
          <AssistantMarkdown key={segment.id} muted={index < lastTaskIndex}>
            {segment.part.text}
          </AssistantMarkdown>
        ) : segment.part.type === "reasoning" ? (
          <ReasoningPartView key={segment.id} part={segment.part} />
        ) : segment.part.type === "tool" && segment.part.tool === "subagent" ? (
          <SubAgentCard key={segment.id} part={segment.part} />
        ) : segment.part.type === "tool" && segment.part.tool === "todowrite" ? (
          <TodoList key={segment.id} part={segment.part} stale={segment.part.id !== lastTodoId} />
        ) : null,
      )}
      {message.error && <MessageError error={message.error} />}
      {finished && sources.length > 0 && (
        <Sources className="mt-2">
          <SourcesTrigger count={sources.length}>
            <p className="font-medium">
              {sources.length} {sources.length === 1 ? "fonte consultada" : "fontes consultadas"}
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
