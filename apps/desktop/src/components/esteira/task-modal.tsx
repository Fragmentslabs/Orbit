import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangleIcon, CheckIcon, FileDiffIcon, PauseIcon, PlayIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react"
import type { Esteira, Task } from "@shared/esteira"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { AssistantMarkdown } from "@/src/components/messages/shared"
import { MediaEmbed } from "./media-embed"
import { SEM_TASKS, useEsteiraStore } from "@/src/stores/esteira-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { cn } from "@/lib/utils"
import { formatarCusto, formatarDuracao } from "./task-card"

/**
 * Modal da task (§13): título editável, tabs de fases com a anotação em
 * markdown, coluna direita com telemetria e dependências, e o banner de erro
 * quando a task pausou por falha.
 */
export function TaskModal({
  task,
  esteira,
  aberto,
  onOpenChange,
}: {
  task: Task | null
  esteira: Esteira
  aberto: boolean
  onOpenChange: (aberto: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const atualizarTask = useEsteiraStore((s) => s.atualizarTask)
  const removerTask = useEsteiraStore((s) => s.removerTask)
  const iniciarTask = useEsteiraStore((s) => s.iniciarTask)
  const pausarTask = useEsteiraStore((s) => s.pausarTask)
  const retomarTask = useEsteiraStore((s) => s.retomarTask)
  const tasks = useEsteiraStore((s) => s.tasksPorEsteira[esteira.id] ?? SEM_TASKS)
  const [titulo, setTitulo] = useState("")
  const [descricao, setDescricao] = useState("")
  const [faseAtiva, setFaseAtiva] = useState(0)
  const [adicionandoDep, setAdicionandoDep] = useState(false)
  const [erroDep, setErroDep] = useState<string | null>(null)
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false)

  useEffect(() => {
    if (!task) return
    setTitulo(task.titulo)
    setDescricao(task.descricao)
    setFaseAtiva(task.faseAtual ?? 0)
  }, [task?.id])

  const anotacaoPorFase = useMemo(() => {
    const mapa = new Map<string, Task["anotacoes"][number]>()
    for (const anotacao of task?.anotacoes ?? []) mapa.set(anotacao.faseId, anotacao)
    return mapa
  }, [task?.anotacoes])

  // +/- do patch, como no rodapé das mensagens do chat
  const linhasDoDiff = useMemo(() => {
    let adicionadas = 0
    let removidas = 0
    for (const linha of (task?.diff?.patch ?? "").split("\n")) {
      if (linha.startsWith("+") && !linha.startsWith("+++")) adicionadas++
      else if (linha.startsWith("-") && !linha.startsWith("---")) removidas++
    }
    return { adicionadas, removidas }
  }, [task?.diff?.patch])

  if (!task) return null

  const comErro = task.pausaMotivo === "erro"
  const dependencias = task.dependeDe
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t)
  const candidatasDep = tasks.filter((t) => t.id !== task.id && !task.dependeDe.includes(t.id))

  const salvarCampo = (patch: Partial<Task>) => {
    void atualizarTask(esteira.id, task.id, patch)
  }

  const alterarDependencias = async (proximas: string[]) => {
    setErroDep(null)
    try {
      await atualizarTask(esteira.id, task.id, { dependeDe: proximas })
    } catch (err) {
      // Ciclo é validado no main — a mensagem vem de lá
      setErroDep(err instanceof Error ? err.message : String(err))
    }
  }

  const dataCurta = (iso?: string) =>
    iso ? new Date(iso).toLocaleString(i18n.language, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"

  return (
    <Dialog open={aberto} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl p-0">
        <DialogTitle className="sr-only">{task.titulo}</DialogTitle>

        {comErro && (
          <div className="flex items-start gap-2 rounded-t-lg border-b border-destructive/30 bg-destructive/10 px-4 py-2.5">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-destructive">{t("esteira.pausadaPorErro")}</p>
              <p className="mt-0.5 text-[11px] text-destructive/90">{task.erro}</p>
            </div>
            <button
              type="button"
              onClick={() => void retomarTask(esteira.id, task.id)}
              className="shrink-0 rounded-md bg-destructive px-3 py-1.5 text-[11px] font-medium text-destructive-foreground hover:bg-destructive/90"
            >
              {t("esteira.retomar")}
            </button>
          </div>
        )}

        {task.pushFalha && (
          <div className="flex items-start gap-2 rounded-t-lg border-b border-yellow-500/30 bg-yellow-500/10 px-4 py-2.5">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-yellow-600 dark:text-yellow-400" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-yellow-700 dark:text-yellow-300">{t("esteira.pushFalhou")}</p>
              <p className="mt-0.5 break-all text-[11px] text-yellow-700/80 dark:text-yellow-300/80">{task.pushFalha}</p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 px-4 pt-4">
          <Input
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
            onBlur={() => titulo !== task.titulo && salvarCampo({ titulo })}
            className="h-8 flex-1 border-0 bg-transparent px-1.5 text-base font-semibold shadow-none focus-visible:ring-0"
          />
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {t(`esteira.status.${task.status}`)}
          </span>
        </div>

        {/* Arquivos alterados: medido pelo engine (snapshot), não relatado pelo
            agente. Clique abre o diff no painel, igual ao chat. */}
        {(task.diff?.arquivos.length ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => {
              usePanelStore.getState().openTaskDiff(esteira.id, task.id, task.titulo)
              onOpenChange(false)
            }}
            className="mx-4 mt-2 flex w-fit items-center gap-2 rounded-md border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
          >
            <FileDiffIcon className="size-3.5" />
            {t("esteira.arquivosAlterados", { count: task.diff!.arquivos.length })}
            {linhasDoDiff.adicionadas > 0 && <span className="text-emerald-500">+{linhasDoDiff.adicionadas}</span>}
            {linhasDoDiff.removidas > 0 && <span className="text-red-500">-{linhasDoDiff.removidas}</span>}
          </button>
        )}

        <div className="flex min-h-0 gap-4 px-4 pb-4 pt-3">
          {/* Esquerda: descrição + tabs de fases */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">{t("esteira.descricao")}</p>
              <textarea
                value={descricao}
                onChange={(e) => setDescricao(e.target.value)}
                onBlur={() => descricao !== task.descricao && salvarCampo({ descricao })}
                rows={3}
                className="w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-ring"
              />
              {/* URLs orbit-media:// coladas na descrição viram imagens (o texto
                  continua sendo a fonte de verdade para as fases) */}
              <MediaEmbed texto={descricao} />
            </div>

            <div className="flex shrink-0 gap-1 overflow-x-auto border-b">
              {esteira.fases.map((fase, indice) => {
                const anotacao = anotacaoPorFase.get(fase.id)
                const executando = task.status === "em_progresso" && task.faseAtual === indice
                return (
                  <button
                    key={fase.id}
                    type="button"
                    onClick={() => setFaseAtiva(indice)}
                    className={cn(
                      "flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs transition-colors",
                      faseAtiva === indice
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {fase.nome}
                    {anotacao?.status === "ok" && <CheckIcon className="size-3 text-emerald-500" />}
                    {anotacao?.status === "erro" && <AlertTriangleIcon className="size-3 text-destructive" />}
                    {anotacao?.status === "pulada" && <span className="text-[10px] opacity-60">↷</span>}
                    {executando && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
                  </button>
                )
              })}
            </div>

            <div className="min-h-48 max-h-[46vh] overflow-y-auto rounded-md border p-3">
              {(() => {
                const fase = esteira.fases[faseAtiva]
                const anotacao = fase ? anotacaoPorFase.get(fase.id) : undefined
                if (!anotacao) {
                  return <p className="text-xs text-muted-foreground">{t("esteira.semAnotacao")}</p>
                }
                return (
                  <>
                    <AssistantMarkdown>{anotacao.conteudo}</AssistantMarkdown>
                    {anotacao.comandosControlados.length > 0 && (
                      <div className="mt-3 rounded-md bg-muted/50 p-2">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {t("esteira.comandosControlados")}
                        </p>
                        <ul className="space-y-0.5">
                          {anotacao.comandosControlados.map((cmd, i) => (
                            <li key={i} className="font-mono text-[10px] text-muted-foreground">{cmd}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          </div>

          {/* Direita: telemetria + dependências */}
          <div className="w-56 shrink-0 space-y-3 text-[11px]">
            <dl className="space-y-1.5">
              <Linha rotulo={t("esteira.criadaEm")} valor={dataCurta(task.criadoEm)} />
              <Linha rotulo={t("esteira.concluidaEm")} valor={dataCurta(task.concluidoEm)} />
              <Linha rotulo={t("esteira.tempoTrabalho")} valor={formatarDuracao(task.tempoTrabalhoMs)} />
              <Linha rotulo={t("esteira.tokens")} valor={task.tokens.toLocaleString()} />
              <Linha rotulo={t("esteira.custo")} valor={formatarCusto(task.custo)} />
            </dl>

            <div className="border-t pt-2">
              <p className="mb-1.5 font-medium text-muted-foreground">{t("esteira.dependenciasTitulo")}</p>
              {dependencias.length === 0 && !adicionandoDep && (
                <p className="text-muted-foreground/70">{t("esteira.semDependencias")}</p>
              )}
              <ul className="space-y-1">
                {dependencias.map((dep) => (
                  <li key={dep.id} className="flex items-center gap-1.5">
                    <span className={cn("size-1.5 shrink-0 rounded-full", dep.status === "concluida" ? "bg-emerald-500" : "bg-amber-500")} />
                    <span className="min-w-0 flex-1 truncate">{dep.titulo}</span>
                    <button
                      type="button"
                      onClick={() => void alterarDependencias(task.dependeDe.filter((id) => id !== dep.id))}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
              {adicionandoDep ? (
                <select
                  autoFocus
                  className="mt-1.5 w-full rounded-md border bg-background px-1.5 py-1 text-[11px]"
                  onChange={(e) => {
                    if (e.target.value) void alterarDependencias([...task.dependeDe, e.target.value])
                    setAdicionandoDep(false)
                  }}
                  onBlur={() => setAdicionandoDep(false)}
                  defaultValue=""
                >
                  <option value="">{t("esteira.selecioneTask")}</option>
                  {candidatasDep.map((c) => (
                    <option key={c.id} value={c.id}>{c.titulo}</option>
                  ))}
                </select>
              ) : (
                candidatasDep.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setAdicionandoDep(true)}
                    className="mt-1.5 flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    <PlusIcon className="size-3" />
                    {t("esteira.adicionarDependencia")}
                  </button>
                )
              )}
              {erroDep && <p className="mt-1 text-[10px] text-destructive">{erroDep}</p>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t px-4 py-2.5">
          {task.status === "em_progresso" ? (
            <BotaoAcao icone={<PauseIcon className="size-3.5" />} rotulo={t("esteira.pausar")} onClick={() => void pausarTask(esteira.id, task.id)} />
          ) : task.status !== "concluida" ? (
            <BotaoAcao
              icone={<PlayIcon className="size-3.5" />}
              rotulo={task.status === "pausada" ? t("esteira.retomar") : t("esteira.iniciar")}
              onClick={() =>
                task.status === "pausada"
                  ? void retomarTask(esteira.id, task.id)
                  : void iniciarTask(esteira.id, task.id)
              }
            />
          ) : null}
          <button
            type="button"
            onClick={() => setConfirmandoExclusao(true)}
            className="ml-auto flex items-center gap-1 rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2Icon className="size-3.5" />
            {t("esteira.excluirTask")}
          </button>
        </div>

        <ConfirmDialog
          open={confirmandoExclusao}
          onOpenChange={setConfirmandoExclusao}
          title={t("esteira.confirmarExclusaoTask", { titulo: task.titulo })}
          description={t("esteira.exclusaoTaskDescricao")}
          confirmLabel={t("esteira.excluirTask")}
          destructive
          onConfirm={() => {
            void removerTask(esteira.id, task.id)
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{rotulo}</dt>
      <dd className="font-medium text-foreground">{valor}</dd>
    </div>
  )
}

function BotaoAcao({ icone, rotulo, onClick }: { icone: React.ReactNode; rotulo: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
    >
      {icone}
      {rotulo}
    </button>
  )
}
