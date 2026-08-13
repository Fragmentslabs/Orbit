import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangleIcon, CheckCircle2Icon, ClockIcon, GitCommitIcon, Loader2Icon } from "lucide-react"
import type { Esteira, Task } from "@shared/esteira"
import { formatarCusto, formatarDuracao } from "./task-card"

/**
 * Relatório da esteira no rodapé do board (§14): uma linha, sem roubar espaço
 * do kanban. Calculado no renderer a partir das tasks que o store já tem —
 * pedir ao main a cada mudança daria uma ida e volta por evento de fase.
 */
export function EsteiraFooter({ esteira, tasks }: { esteira: Esteira; tasks: Task[] }) {
  const { t } = useTranslation()

  const resumo = useMemo(() => {
    const commits = new Set<string>()
    let tokens = 0
    let custo = 0
    let tempo = 0
    for (const task of tasks) {
      tokens += task.tokens
      custo += task.custo
      tempo += task.tempoTrabalhoMs
      for (const anotacao of task.anotacoes) if (anotacao.commitHash) commits.add(anotacao.commitHash)
    }
    return {
      concluidas: tasks.filter((t) => t.status === "concluida").length,
      falhas: tasks.filter((t) => t.pausaMotivo === "erro").length,
      andamento: tasks.filter((t) => t.status === "em_progresso").length,
      total: tasks.length,
      commits: [...commits],
      tokens,
      custo,
      tempo,
    }
  }, [tasks])

  if (tasks.length === 0) return null

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">{esteira.nome}</span>
      <Item icone={<CheckCircle2Icon className="size-3 text-emerald-500" />} valor={`${resumo.concluidas}/${resumo.total}`} titulo={t("esteira.concluidas")} />
      {resumo.andamento > 0 && (
        <Item icone={<Loader2Icon className="size-3 animate-spin text-primary" />} valor={String(resumo.andamento)} titulo={t("esteira.emAndamento")} />
      )}
      {resumo.falhas > 0 && (
        <Item icone={<AlertTriangleIcon className="size-3 text-destructive" />} valor={String(resumo.falhas)} titulo={t("esteira.falhas")} />
      )}
      {resumo.commits.length > 0 && (
        <Item
          icone={<GitCommitIcon className="size-3" />}
          valor={resumo.commits.slice(0, 3).map((c) => c.slice(0, 7)).join(", ") + (resumo.commits.length > 3 ? "…" : "")}
          titulo={t("esteira.commits")}
        />
      )}
      <Item icone={<ClockIcon className="size-3" />} valor={formatarDuracao(resumo.tempo)} titulo={t("esteira.tempoTotal")} />
      <span title={t("esteira.tokens")}>{resumo.tokens.toLocaleString()} tok</span>
      <span title={t("esteira.custo")}>{formatarCusto(resumo.custo)}</span>
    </div>
  )
}

function Item({ icone, valor, titulo }: { icone: React.ReactNode; valor: string; titulo: string }) {
  return (
    <span className="flex items-center gap-1" title={titulo}>
      {icone}
      {valor}
    </span>
  )
}
