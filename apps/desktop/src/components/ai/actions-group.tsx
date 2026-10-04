import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ToolPart } from "@shared/chat"
import { Task, TaskContent, TaskItem, TaskItemFile, TaskTrigger } from "@/src/components/ai/task"
import { Shimmer } from "@/src/components/ai/shimmer"

/**
 * As ferramentas de um turno, recolhidas numa linha só.
 *
 * O modo código sempre fez isso: enquanto trabalha, a lista fica aberta e se
 * acompanha o que está acontecendo; quando a resposta chega, tudo se fecha em
 * "27 ações realizadas" e o que fica na conversa é a RESPOSTA. No chat cada
 * chamada virava um card que ficava ali para sempre, e reler a conversa era
 * rolar por cima da escada que levou até ela.
 *
 * Isto aqui é o pedaço comum dos dois. O modo código tem o seu próprio grupo
 * por cima deste (com o diff e o resumo de testes, que só existem lá); o chat
 * usa este direto.
 */

/** Quantas ferramentas aparecem sem pedir "mostrar todas". */
const MAX_VISIBLE = 6

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

/** O argumento que identifica a chamada: caminho, busca, url, comando. */
export function toolChip(part: ToolPart): string | undefined {
  const input = part.input ?? {}
  const candidate =
    input.filePath ?? input.dirPath ?? input.pattern ?? input.query ?? input.url ?? input.command
  if (typeof candidate !== "string" || !candidate) return undefined
  const isPath = typeof input.filePath === "string" || typeof input.dirPath === "string"
  return isPath ? candidate.split(/[\\/]/).pop() : candidate
}

export function ToolActionItem({ part }: { part: ToolPart }) {
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
            {/* title = comando/caminho completo no hover (o truncate corta em ~256px) */}
            <span className="max-w-64 truncate font-mono" title={chip}>
              {chip}
            </span>
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

/**
 * Abre sozinho enquanto trabalha e fecha sozinho um segundo depois de
 * terminar. O atraso é de propósito: fechar no mesmo instante em que o último
 * resultado aparece é a diferença entre "acompanhei" e "piscou".
 */
export function ActionsGroup({
  parts,
  className,
  flat,
}: {
  parts: ToolPart[]
  className?: string
  /** Modo detalhado: cada ação listada, sem acordeon nem "mostrar mais". */
  flat?: boolean
}) {
  const { t } = useTranslation()
  const working = parts.some((p) => p.state === "running")
  const errors = parts.filter((p) => p.state === "error").length
  const [open, setOpen] = useState(working)
  const [showAll, setShowAll] = useState(false)
  const prevWorking = useRef(working)

  useEffect(() => {
    if (working) setOpen(true)
  }, [working])

  useEffect(() => {
    if (prevWorking.current && !working) {
      const timer = setTimeout(() => setOpen(false), 1000)
      return () => clearTimeout(timer)
    }
    prevWorking.current = working
  }, [working])

  useEffect(() => {
    setShowAll(false)
  }, [parts.length])

  const visibleParts = showAll ? parts : parts.slice(-MAX_VISIBLE)
  const hiddenCount = parts.length - visibleParts.length

  const title = working
    ? t("chat.code.working")
    : errors > 0
      ? t("chat.code.actionsWithError", { count: parts.length, errors })
      : t("chat.code.actionsDone", { count: parts.length })

  if (flat) {
    return (
      <div className={cn("not-prose my-2 flex w-full flex-col gap-1", className)}>
        {parts.map((part) => (
          <ToolActionItem key={part.id} part={part} />
        ))}
      </div>
    )
  }

  return (
    <Task open={open} onOpenChange={setOpen} className={cn("not-prose my-2 w-full", className)}>
      <TaskTrigger title={title}>
        <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
          {working ? <Shimmer>{title}</Shimmer> : <p className="text-sm">{title}</p>}
          <ChevronDownIcon
            className={cn("ml-auto size-4 transition-transform", open ? "rotate-0" : "-rotate-90")}
          />
        </div>
      </TaskTrigger>
      <TaskContent>
        {visibleParts.map((part) => (
          <ToolActionItem key={part.id} part={part} />
        ))}
        {hiddenCount > 0 && !showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("chat.code.hiddenActions", { count: hiddenCount })}
          </button>
        )}
      </TaskContent>
    </Task>
  )
}
