import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { DndContext, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { LayersIcon, PlayIcon, PlusIcon, SquareIcon, Trash2Icon } from "lucide-react"
import type { Esteira, Task } from "@shared/esteira"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { esteiraApi } from "@/src/lib/ipc"
import { useEsteiraStore } from "@/src/stores/esteira-store"
import { cn } from "@/lib/utils"
import { EsteiraCreateDialog } from "./esteira-create-dialog"
import { EsteiraFooter } from "./esteira-footer"
import { TaskCard } from "./task-card"
import { TaskModal } from "./task-modal"

/**
 * Página do modo esteira: seleção de projeto/esteira, kanban por fase e o
 * rodapé de relatório.
 *
 * O kanban existe para viabilizar o drag (D8): soltar um card numa coluna de
 * fase inicia a task DAQUELA fase em diante. Um DndContext local mantém isso
 * separado do drag global do app (arrastar chats para o painel direito).
 */
export function EsteiraBoard() {
  const { t } = useTranslation()
  const store = useEsteiraStore()
  const projetos = useEsteiraStore((s) => s.projetos)
  const esteiras = useEsteiraStore((s) => s.esteiras)
  const carregado = useEsteiraStore((s) => s.carregado)

  const [projetoId, setProjetoId] = useState<string | null>(null)
  const [esteiraId, setEsteiraId] = useState<string | null>(null)
  const [criarAberto, setCriarAberto] = useState(false)
  const [taskAberta, setTaskAberta] = useState<string | null>(null)
  const [novaTask, setNovaTask] = useState("")

  useEffect(() => {
    if (!carregado) void store.carregar()
  }, [carregado])

  // Assina os eventos do engine: fases concluindo, tasks pausando, fila andando.
  useEffect(() => esteiraApi.onEvent((evento) => useEsteiraStore.getState().aplicarEvento(evento)), [])

  // Seleção inicial: primeiro projeto e primeira esteira, para o board nunca
  // abrir vazio quando já existe algo configurado.
  useEffect(() => {
    if (!projetoId && projetos.length > 0) setProjetoId(projetos[0].id)
  }, [projetos, projetoId])

  const esteirasDoProjeto = useMemo(
    () => esteiras.filter((e) => e.projetoId === projetoId),
    [esteiras, projetoId],
  )

  useEffect(() => {
    if (esteirasDoProjeto.length === 0) setEsteiraId(null)
    else if (!esteirasDoProjeto.some((e) => e.id === esteiraId)) setEsteiraId(esteirasDoProjeto[0].id)
  }, [esteirasDoProjeto, esteiraId])

  const esteira = esteirasDoProjeto.find((e) => e.id === esteiraId) ?? null
  const tasks = useEsteiraStore((s) => (esteiraId ? s.tasksPorEsteira[esteiraId] ?? [] : []))
  const filaLigada = useEsteiraStore((s) => (esteiraId ? s.filasLigadas[esteiraId] ?? false : false))

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const aoSoltar = useCallback(
    (evento: DragEndEvent) => {
      const task = evento.active.data.current?.task as Task | undefined
      const destino = String(evento.over?.id ?? "")
      if (!task || !esteira || !destino.startsWith("fase:")) return
      const indice = Number(destino.slice("fase:".length))
      if (!Number.isInteger(indice) || indice < 0 || indice >= esteira.fases.length) return
      // Soltar na fase em que a task já está e rodando não tem efeito
      if (task.status === "em_progresso" && task.faseAtual === indice) return
      void store.iniciarTask(esteira.id, task.id, indice)
    },
    [esteira, store],
  )

  const criarTask = async () => {
    const titulo = novaTask.trim()
    if (!titulo || !esteira) return
    setNovaTask("")
    await store.criarTask(esteira.id, titulo, "")
  }

  if (!carregado) {
    return <p className="p-6 text-center text-xs text-muted-foreground">{t("esteira.carregando")}</p>
  }

  if (projetos.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <LayersIcon className="size-10 text-muted-foreground/60" />
        <div>
          <p className="text-sm font-medium">{t("esteira.vazioTitulo")}</p>
          <p className="max-w-xs text-xs text-muted-foreground">{t("esteira.vazioSubtitulo")}</p>
        </div>
        <Button size="sm" onClick={() => setCriarAberto(true)}>
          <PlusIcon className="size-4" />
          {t("esteira.novaEsteira")}
        </Button>
        <EsteiraCreateDialog aberto={criarAberto} onOpenChange={setCriarAberto} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Seletores + controles da esteira */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 pb-3">
        <select
          value={projetoId ?? ""}
          onChange={(e) => setProjetoId(e.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          {projetos.map((p) => (
            <option key={p.id} value={p.id}>{p.nome}</option>
          ))}
        </select>

        {esteirasDoProjeto.length > 0 && (
          <select
            value={esteiraId ?? ""}
            onChange={(e) => setEsteiraId(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            {esteirasDoProjeto.map((e) => (
              <option key={e.id} value={e.id}>{e.nome}</option>
            ))}
          </select>
        )}

        <Button variant="ghost" size="sm" onClick={() => setCriarAberto(true)}>
          <PlusIcon className="size-4" />
          {t("esteira.novaEsteira")}
        </Button>

        {esteira && (
          <>
            <button
              type="button"
              onClick={() => void store.alternarFila(esteira.id, !filaLigada)}
              title={t("esteira.filaDica")}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
                filaLigada ? "border-primary/50 bg-primary/10 text-primary" : "hover:bg-accent",
              )}
            >
              {filaLigada ? <SquareIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
              {filaLigada ? t("esteira.filaLigada") : t("esteira.filaDesligada")}
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirm(t("esteira.confirmarRemocao", { nome: esteira.nome }))) {
                  void store.removerEsteira(esteira.id)
                }
              }}
              className="ml-auto flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title={t("esteira.removerEsteira")}
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </>
        )}
      </div>

      {esteira ? (
        <>
          {/* Entrada rápida de task */}
          <div className="flex shrink-0 gap-2 pb-3">
            <Input
              value={novaTask}
              onChange={(e) => setNovaTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void criarTask()
              }}
              placeholder={t("esteira.novaTaskPlaceholder")}
              className="h-8 max-w-md text-xs"
            />
            <Button size="sm" variant="secondary" disabled={!novaTask.trim()} onClick={() => void criarTask()}>
              {t("esteira.adicionar")}
            </Button>
          </div>

          <DndContext sensors={sensors} onDragEnd={aoSoltar}>
            <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
              <Coluna
                id="pendentes"
                titulo={t("esteira.pendentes")}
                tasks={tasks.filter((t) => t.status === "pendente")}
                esteira={esteira}
                onAbrir={setTaskAberta}
              />
              {esteira.fases.map((fase, indice) => (
                <Coluna
                  key={fase.id}
                  id={`fase:${indice}`}
                  titulo={fase.nome}
                  tasks={tasks.filter((t) => t.status !== "pendente" && t.status !== "concluida" && t.faseAtual === indice)}
                  esteira={esteira}
                  onAbrir={setTaskAberta}
                />
              ))}
              <Coluna
                id="concluidas"
                titulo={t("esteira.concluidas")}
                tasks={tasks.filter((t) => t.status === "concluida")}
                esteira={esteira}
                onAbrir={setTaskAberta}
              />
            </div>
          </DndContext>

          <EsteiraFooter esteira={esteira} tasks={tasks} />
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-sm text-muted-foreground">{t("esteira.semEsteiras")}</p>
          <Button size="sm" onClick={() => setCriarAberto(true)}>
            <PlusIcon className="size-4" />
            {t("esteira.novaEsteira")}
          </Button>
        </div>
      )}

      <EsteiraCreateDialog aberto={criarAberto} onOpenChange={setCriarAberto} projetoId={projetoId ?? undefined} />
      {esteira && (
        <TaskModal
          esteira={esteira}
          task={tasks.find((t) => t.id === taskAberta) ?? null}
          aberto={!!taskAberta}
          onOpenChange={(aberto) => !aberto && setTaskAberta(null)}
        />
      )}
    </div>
  )
}

function Coluna({
  id,
  titulo,
  tasks,
  esteira,
  onAbrir,
}: {
  id: string
  titulo: string
  tasks: Task[]
  esteira: Esteira
  onAbrir: (taskId: string) => void
}) {
  const store = useEsteiraStore()
  const progresso = useEsteiraStore((s) => s.progresso)
  const { setNodeRef, isOver } = useDroppable({ id })
  const aceitaDrop = id.startsWith("fase:")

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-60 shrink-0 flex-col rounded-lg border bg-muted/20 transition-colors",
        isOver && aceitaDrop && "border-primary bg-primary/5",
      )}
    >
      <div className="flex shrink-0 items-center justify-between px-2.5 py-2">
        <span className="text-xs font-medium text-foreground">{titulo}</span>
        <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{tasks.length}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-2">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            esteira={esteira}
            progresso={progresso[task.id]}
            onAbrir={() => onAbrir(task.id)}
            onIniciar={() => void store.iniciarTask(esteira.id, task.id)}
            onPausar={() => void store.pausarTask(esteira.id, task.id)}
            onRetomar={() => void store.retomarTask(esteira.id, task.id)}
          />
        ))}
      </div>
    </div>
  )
}
