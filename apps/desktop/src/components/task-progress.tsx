"use client"

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, ChevronDown, ClockIcon, EyeIcon, LoaderIcon, MessageSquareIcon, TerminalIcon, WrenchIcon, X, XCircleIcon } from "lucide-react"
import type { FaseTarefaOrquestra } from "@shared/chat"
import { cn } from "@/lib/utils"

export interface TaskItem {
  id: string
  title: string
  status: "idle" | "submitted" | "streaming" | "cancelling" | "fallback" | "error"
  mode?: "chat" | "code"
  /** Etapa no acompanhamento da orquestra — quando presente, manda no ícone e no "concluído" */
  fase?: FaseTarefaOrquestra
  /** Worker criado pelo orquestrador durante a revisão */
  extra?: boolean
  /** Ajustes que já recebeu */
  revisions?: number
  /** Nota da revisão (o ajuste pedido, ou por que falhou) — no tooltip */
  nota?: string
}

/** O orquestrador acompanhando (orquestra): o que ele está fazendo e o orçamento. */
export interface Acompanhamento {
  atividade?: string
  ajustesUsados: number
  tetoAjustes: number
  merge?: { ok: boolean; detalhe: string; pendente?: boolean }
}

const FASES_ABERTAS = new Set<FaseTarefaOrquestra>(["fila", "rodando", "revisao", "ajuste"])

export function TaskProgress({
  tasks,
  title,
  defaultExpanded = true,
  onDismiss,
  acompanhamento,
  onJuntarDeNovo,
}: {
  tasks: TaskItem[]
  title?: string
  defaultExpanded?: boolean
  onDismiss?: () => void
  acompanhamento?: Acompanhamento
  /** Trabalho aceito que ficou fora do chat: tentar juntar de novo */
  onJuntarDeNovo?: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [juntando, setJuntando] = useState(false)
  const total = tasks.length
  // Com etapas (orquestra que acompanha), "concluída" é aceita pelo
  // orquestrador — terminar de rodar ainda passa pela revisão.
  const done = tasks.filter((t) => (t.fase ? t.fase === "aceita" : t.status === "idle")).length
  const running =
    tasks.some((t) => (t.fase ? FASES_ABERTAS.has(t.fase) : t.status === "submitted" || t.status === "streaming" || t.status === "cancelling" || t.status === "fallback")) ||
    !!acompanhamento?.atividade
  const hasErrors = tasks.some((t) => (t.fase ? t.fase === "falhou" : t.status === "error"))
  const progress = total > 0 ? Math.round((done / total) * 100) : 0
  const allDoneOrError = !running && (done === total || hasErrors)

  if (total === 0) return null

  return (
    <div className="rounded-xl border border-sidebar-border bg-sidebar/50 text-xs">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-sidebar-accent/30 transition-colors"
        >
          <ChevronDown className={cn("size-3 shrink-0 transition-transform text-muted-foreground", !expanded && "-rotate-90")} />
          {running ? (
            <LoaderIcon className="size-3.5 shrink-0 animate-spin text-primary" />
          ) : allDoneOrError && hasErrors ? (
            <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
          ) : (
            <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
          )}
          <span className="font-medium text-foreground">
            {running
              ? t("taskProgress.inProgress", { title: title ?? t("taskProgress.title") })
              : allDoneOrError && hasErrors
                ? t("taskProgress.errors", { title: title ?? t("taskProgress.title") })
                : t("taskProgress.done", { title: title ?? t("taskProgress.title") })}
          </span>
          <span className="text-muted-foreground">
            {done}/{total}
          </span>
          <div className="ml-auto h-1.5 min-w-16 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                hasErrors ? "bg-destructive" : "bg-primary",
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        </button>
        {allDoneOrError && onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="mr-2 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-sidebar-accent"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      {expanded && acompanhamento && (acompanhamento.atividade || acompanhamento.tetoAjustes > 0 || acompanhamento.merge) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-sidebar-border px-3 py-1.5 text-[11px] text-muted-foreground">
          {acompanhamento.atividade && (
            <span className="flex min-w-0 items-center gap-1.5 text-foreground">
              <EyeIcon className="size-3 shrink-0 text-primary" />
              <span className="truncate">{acompanhamento.atividade}</span>
            </span>
          )}
          {acompanhamento.tetoAjustes > 0 && (
            <span className="ml-auto tabular-nums">
              {t("taskProgress.ajustes", { usados: acompanhamento.ajustesUsados, teto: acompanhamento.tetoAjustes })}
            </span>
          )}
          {acompanhamento.merge && (
            <span className={cn("basis-full", acompanhamento.merge.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
              {acompanhamento.merge.detalhe}
            </span>
          )}
          {acompanhamento.merge?.pendente && onJuntarDeNovo && !running && (
            <button
              type="button"
              disabled={juntando}
              onClick={() => {
                setJuntando(true)
                void onJuntarDeNovo().finally(() => setJuntando(false))
              }}
              className="flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-sidebar-accent disabled:opacity-50"
            >
              {juntando && <LoaderIcon className="size-3 animate-spin" />}
              {t("taskProgress.juntarDeNovo")}
            </button>
          )}
        </div>
      )}

      {expanded && (
        <div className="border-t border-sidebar-border px-1 pb-1.5 pt-1">
          {tasks.map((task) => {
            const isDone = task.fase ? task.fase === "aceita" : task.status === "idle"
            return (
              <div
                key={task.id}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1",
                  isDone && "opacity-60",
                )}
                title={task.nota}
              >
                {task.fase ? <FaseIcon fase={task.fase} /> : <TaskIcon status={task.status} />}
                {task.mode === "code" ? (
                  <TerminalIcon className="size-3 shrink-0 text-muted-foreground" />
                ) : task.mode === "chat" ? (
                  <MessageSquareIcon className="size-3 shrink-0 text-muted-foreground" />
                ) : null}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    isDone && "line-through text-muted-foreground",
                  )}
                  title={task.title}
                >
                  {task.title}
                </span>
                {task.extra && (
                  <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{t("taskProgress.extra")}</span>
                )}
                {task.fase && task.fase !== "aceita" && task.fase !== "rodando" && (
                  <span className={cn("shrink-0 text-[10px]", task.fase === "falhou" ? "text-destructive" : "text-muted-foreground")}>
                    {task.fase === "ajuste"
                      ? t("taskProgress.fase.ajuste", { n: task.revisions ?? 1 })
                      : t(`taskProgress.fase.${task.fase}`)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TaskIcon({ status }: { status: TaskItem["status"] }) {
  switch (status) {
    case "submitted":
    case "streaming":
    case "fallback":
      return <LoaderIcon className="size-3.5 shrink-0 animate-spin text-primary" />
    case "error":
      return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
    case "idle":
      return <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
    default:
      return <div className="size-3.5 shrink-0 rounded-full border border-muted-foreground/30" />
  }
}

function FaseIcon({ fase }: { fase: FaseTarefaOrquestra }) {
  switch (fase) {
    case "fila":
      return <ClockIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
    case "rodando":
      return <LoaderIcon className="size-3.5 shrink-0 animate-spin text-primary" />
    case "revisao":
      return <EyeIcon className="size-3.5 shrink-0 animate-pulse text-primary" />
    case "ajuste":
      return <WrenchIcon className="size-3.5 shrink-0 animate-pulse text-amber-500" />
    case "aceita":
      return <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
    case "falhou":
      return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
  }
}
