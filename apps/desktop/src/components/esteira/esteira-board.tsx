import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { DndContext, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { ArrowLeftIcon, FolderIcon, LayersIcon, PlayIcon, PlusIcon, SquareIcon, Trash2Icon } from "lucide-react"
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
 * Página Esteira (modo código, na sidebar). Dois níveis:
 *
 *   lista de esteiras  →  [abrir]  →  board da esteira (colunas por fase)
 *
 * Não é um modo do input: a esteira é outra forma de trabalhar — pipeline de
 * tasks sem chat — então ela navega como página, e não como toggle de conversa.
 */
export function EsteiraBoard() {
  const { t } = useTranslation()
  const carregado = useEsteiraStore((s) => s.carregado)
  const carregar = useEsteiraStore((s) => s.carregar)
  const [abertaId, setAbertaId] = useState<string | null>(null)

  useEffect(() => {
    if (!carregado) void carregar()
  }, [carregado, carregar])

  // Assina os eventos do engine: fases concluindo, tasks pausando, fila andando
  useEffect(() => esteiraApi.onEvent((evento) => useEsteiraStore.getState().aplicarEvento(evento)), [])

  const esteiras = useEsteiraStore((s) => s.esteiras)
  const aberta = esteiras.find((e) => e.id === abertaId) ?? null

  // Esteira removida (por aqui ou por outra janela): volta para a lista em vez
  // de deixar a tela presa num board que não existe mais.
  useEffect(() => {
    if (abertaId && !aberta) setAbertaId(null)
  }, [abertaId, aberta])

  if (!carregado) {
    return <p className="p-6 text-center text-xs text-muted-foreground">{t("esteira.carregando")}</p>
  }

  return aberta ? (
    <BoardDaEsteira esteira={aberta} onVoltar={() => setAbertaId(null)} />
  ) : (
    <ListaDeEsteiras onAbrir={setAbertaId} />
  )
}

// ─── Nível 1: lista de esteiras ──────────────────────────────────────────────

function ListaDeEsteiras({ onAbrir }: { onAbrir: (id: string) => void }) {
  const { t } = useTranslation()
  const esteiras = useEsteiraStore((s) => s.esteiras)
  const projetos = useEsteiraStore((s) => s.projetos)
  const tasksPorEsteira = useEsteiraStore((s) => s.tasksPorEsteira)
  const [criarAberto, setCriarAberto] = useState(false)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 pb-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">{t("esteira.titulo")}</h2>
          <p className="text-xs text-muted-foreground">{t("esteira.subtitulo")}</p>
        </div>
        <Button size="sm" onClick={() => setCriarAberto(true)}>
          <PlusIcon className="size-4" />
          {t("esteira.novaEsteira")}
        </Button>
      </div>

      {esteiras.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <LayersIcon className="size-10 text-muted-foreground/50" />
          <div>
            <p className="text-sm font-medium">{t("esteira.vazioTitulo")}</p>
            <p className="mx-auto max-w-sm text-xs text-muted-foreground">{t("esteira.vazioSubtitulo")}</p>
          </div>
          <Button size="sm" onClick={() => setCriarAberto(true)}>
            <PlusIcon className="size-4" />
            {t("esteira.criarPrimeira")}
          </Button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-min gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
          {esteiras.map((esteira) => {
            const tasks = tasksPorEsteira[esteira.id] ?? []
            const projeto = projetos.find((p) => p.id === esteira.projetoId)
            const emAndamento = tasks.filter((t) => t.status === "em_progresso").length
            const concluidas = tasks.filter((t) => t.status === "concluida").length
            return (
              <button
                key={esteira.id}
                type="button"
                onClick={() => onAbrir(esteira.id)}
                className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors hover:border-ring"
              >
                <div className="flex items-center gap-2">
                  <LayersIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{esteira.nome}</span>
                  {emAndamento > 0 && <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" />}
                </div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {esteira.fases.map((f) => f.nome).join(" → ")}
                </p>
                {projeto && projeto.pastas.length > 0 && (
                  <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                    <FolderIcon className="size-3 shrink-0" />
                    {projeto.pastas[0]}
                    {projeto.pastas.length > 1 && ` +${projeto.pastas.length - 1}`}
                  </p>
                )}
                <div className="mt-auto flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{t("esteira.tasksResumo", { total: tasks.length, concluidas })}</span>
                  {esteira.branch && <span className="truncate">· {esteira.branch}</span>}
                </div>
              </button>
            )
          })}
        </div>
      )}

      <EsteiraCreateDialog aberto={criarAberto} onOpenChange={setCriarAberto} onCriada={onAbrir} />
    </div>
  )
}

// ─── Nível 2: board da esteira ───────────────────────────────────────────────

function BoardDaEsteira({ esteira, onVoltar }: { esteira: Esteira; onVoltar: () => void }) {
  const { t } = useTranslation()
  const store = useEsteiraStore()
  const tasks = useEsteiraStore((s) => s.tasksPorEsteira[esteira.id] ?? [])
  const filaLigada = useEsteiraStore((s) => s.filasLigadas[esteira.id] ?? false)
  const [taskAberta, setTaskAberta] = useState<string | null>(null)
  const [adicionando, setAdicionando] = useState(false)
  const [novaTask, setNovaTask] = useState("")

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const aoSoltar = useCallback(
    (evento: DragEndEvent) => {
      const task = evento.active.data.current?.task as Task | undefined
      const destino = String(evento.over?.id ?? "")
      if (!task || !destino.startsWith("fase:")) return
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
    if (!titulo) return
    setNovaTask("")
    setAdicionando(false)
    await store.criarTask(esteira.id, titulo, "")
  }

  const colunas = useMemo(
    () => [
      { id: "pendentes", titulo: t("esteira.pendentes"), tasks: tasks.filter((x) => x.status === "pendente") },
      ...esteira.fases.map((fase, indice) => ({
        id: `fase:${indice}`,
        titulo: fase.nome,
        tasks: tasks.filter(
          (x) => x.status !== "pendente" && x.status !== "concluida" && x.faseAtual === indice,
        ),
      })),
      { id: "concluidas", titulo: t("esteira.concluidas"), tasks: tasks.filter((x) => x.status === "concluida") },
    ],
    [esteira.fases, tasks, t],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header da esteira: voltar + nome + controles */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 pb-3">
        <button
          type="button"
          onClick={onVoltar}
          title={t("esteira.voltar")}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{esteira.nome}</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {esteira.fases.map((f) => f.nome).join(" → ")}
            {esteira.branch && ` · ${esteira.branch}`}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={() => setAdicionando(true)}>
            <PlusIcon className="size-4" />
            {t("esteira.adicionarTarefa")}
          </Button>
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
                onVoltar()
              }
            }}
            title={t("esteira.removerEsteira")}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2Icon className="size-3.5" />
          </button>
        </div>
      </div>

      {adicionando && (
        <div className="flex shrink-0 gap-2 pb-3">
          <Input
            autoFocus
            value={novaTask}
            onChange={(e) => setNovaTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void criarTask()
              if (e.key === "Escape") setAdicionando(false)
            }}
            placeholder={t("esteira.novaTaskPlaceholder")}
            className="h-8 max-w-md text-xs"
          />
          <Button size="sm" variant="secondary" disabled={!novaTask.trim()} onClick={() => void criarTask()}>
            {t("esteira.adicionar")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdicionando(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      )}

      <DndContext sensors={sensors} onDragEnd={aoSoltar}>
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
          {colunas.map((coluna) => (
            <Coluna
              key={coluna.id}
              id={coluna.id}
              titulo={coluna.titulo}
              tasks={coluna.tasks}
              esteira={esteira}
              onAbrir={setTaskAberta}
            />
          ))}
        </div>
      </DndContext>

      <EsteiraFooter esteira={esteira} tasks={tasks} />

      <TaskModal
        esteira={esteira}
        task={tasks.find((x) => x.id === taskAberta) ?? null}
        aberto={!!taskAberta}
        onOpenChange={(aberto) => !aberto && setTaskAberta(null)}
      />
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
