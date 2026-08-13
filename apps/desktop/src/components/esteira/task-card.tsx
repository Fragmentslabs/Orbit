import { useDraggable } from "@dnd-kit/core"
import { useTranslation } from "react-i18next"
import { AlertTriangleIcon, ClockIcon, Loader2Icon, PauseIcon, PlayIcon } from "lucide-react"
import type { Esteira, Task } from "@shared/esteira"
import { cn } from "@/lib/utils"

/** Formata milissegundos como "12min" / "1h 05min". */
export function formatarDuracao(ms: number): string {
  const minutos = Math.round(ms / 60_000)
  if (minutos < 60) return `${minutos}min`
  return `${Math.floor(minutos / 60)}h ${String(minutos % 60).padStart(2, "0")}min`
}

export function formatarCusto(valor: number): string {
  return valor >= 0.01 ? `$${valor.toFixed(2)}` : `$${valor.toFixed(4)}`
}

/**
 * Card da task no board. Arrastável: soltar numa coluna de fase inicia a task
 * daquela fase em diante (D8) — por isso o card carrega a task inteira nos
 * dados do drag, e a coluna decide o que fazer.
 */
export function TaskCard({
  task,
  esteira,
  progresso,
  onAbrir,
  onIniciar,
  onPausar,
  onRetomar,
}: {
  task: Task
  esteira: Esteira
  progresso?: string
  onAbrir: () => void
  onIniciar: () => void
  onPausar: () => void
  onRetomar: () => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `task:${task.id}`,
    data: { task },
  })

  const emExecucao = task.status === "em_progresso"
  const comErro = task.pausaMotivo === "erro"
  const faseNome = task.faseAtual != null ? esteira.fases[task.faseAtual]?.nome : undefined

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onAbrir}
      className={cn(
        "group cursor-pointer rounded-lg border bg-card p-2.5 text-left shadow-sm transition-colors hover:border-ring",
        isDragging && "opacity-40",
        comErro && "border-destructive/50",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{task.titulo}</span>
        {emExecucao ? (
          <button
            type="button"
            title={t("esteira.pausar")}
            onClick={(e) => {
              e.stopPropagation()
              onPausar()
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <PauseIcon className="size-3" />
          </button>
        ) : task.status !== "concluida" ? (
          <button
            type="button"
            title={comErro ? t("esteira.retomar") : t("esteira.iniciar")}
            onClick={(e) => {
              e.stopPropagation()
              if (task.status === "pausada") onRetomar()
              else onIniciar()
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <PlayIcon className="size-3" />
          </button>
        ) : null}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        {emExecucao && (
          <span className="flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-primary">
            <Loader2Icon className="size-2.5 animate-spin" />
            {faseNome}
          </span>
        )}
        {comErro && (
          <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-destructive">
            <AlertTriangleIcon className="size-2.5" />
            {t("esteira.erro")}
          </span>
        )}
        {task.pushFalha && (
          <span
            title={task.pushFalha}
            className="flex items-center gap-1 rounded-full bg-yellow-500/15 px-1.5 py-0.5 text-yellow-600 dark:text-yellow-400"
          >
            <AlertTriangleIcon className="size-2.5" />
            {t("esteira.pushFalhou")}
          </span>
        )}
        {task.status === "pausada" && !comErro && (
          <span className="flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5">
            <PauseIcon className="size-2.5" />
            {faseNome ?? t("esteira.pausada")}
          </span>
        )}
        {task.tempoTrabalhoMs > 0 && (
          <span className="flex items-center gap-1">
            <ClockIcon className="size-2.5" />
            {formatarDuracao(task.tempoTrabalhoMs)}
          </span>
        )}
        {task.tokens > 0 && <span>{task.tokens.toLocaleString()} tok</span>}
        {task.dependeDe.length > 0 && <span>· {t("esteira.dependencias", { count: task.dependeDe.length })}</span>}
      </div>

      {/* Feed ao vivo: só o rabicho final do que o agente está escrevendo */}
      {emExecucao && progresso && (
        <p className="mt-1.5 line-clamp-2 text-[10px] leading-tight text-muted-foreground/80">{progresso.slice(-160)}</p>
      )}
    </div>
  )
}
