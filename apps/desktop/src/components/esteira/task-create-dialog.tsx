import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon, XIcon } from "lucide-react"
import type { Task } from "@shared/esteira"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ListaTasksBuscavel } from "./task-picker"
import { cn } from "@/lib/utils"
import { MediaEmbed } from "./media-embed"

/**
 * Modal de nova task: título, descrição e dependências.
 *
 * A descrição é o briefing que as fases recebem — a task roda sem chat, então
 * o que não estiver aqui não chega ao agente.
 */
export function TaskCreateDialog({
  aberto,
  onOpenChange,
  tasks,
  onCriar,
}: {
  aberto: boolean
  onOpenChange: (aberto: boolean) => void
  /** Tasks da esteira, candidatas a dependência */
  tasks: Task[]
  onCriar: (dados: { titulo: string; descricao: string; dependeDe: string[] }) => Promise<void>
}) {
  const { t } = useTranslation()
  const [titulo, setTitulo] = useState("")
  const [descricao, setDescricao] = useState("")
  const [dependeDe, setDependeDe] = useState<string[]>([])
  const [salvando, setSalvando] = useState(false)

  useEffect(() => {
    if (!aberto) return
    setTitulo("")
    setDescricao("")
    setDependeDe([])
  }, [aberto])

  const criar = async () => {
    if (!titulo.trim() || salvando) return
    setSalvando(true)
    try {
      await onCriar({ titulo: titulo.trim(), descricao: descricao.trim(), dependeDe })
      onOpenChange(false)
    } finally {
      setSalvando(false)
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{t("esteira.novaTask")}</DialogTitle>

        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("esteira.taskTitulo")}</p>
            <Input
              autoFocus
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              className="h-8 text-sm"
              placeholder={t("esteira.taskTituloExemplo")}
            />
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium">{t("esteira.taskDescricao")}</p>
            <p className="text-[11px] text-muted-foreground">{t("esteira.taskDescricaoDica")}</p>
            <textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              rows={6}
              className="w-full resize-y rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-ring"
            />
            <MediaEmbed texto={descricao} />
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium">{t("esteira.taskDependencias")}</p>
            <p className="text-[11px] text-muted-foreground">{t("esteira.taskDependenciasDica")}</p>
            <SeletorDependencias tasks={tasks} selecionadas={dependeDe} onChange={setDependeDe} />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!titulo.trim() || salvando} onClick={() => void criar()}>
            {t("esteira.criarTask")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Seletor de dependências: popover com busca em cima e a lista abaixo; o que
 * foi escolhido aparece no próprio trigger. Uma lista solta não serve — numa
 * esteira com dezenas de tasks, achar a certa exige busca.
 */
export function SeletorDependencias({
  tasks,
  selecionadas,
  onChange,
  className,
}: {
  tasks: Task[]
  selecionadas: string[]
  onChange: (ids: string[]) => void
  className?: string
}) {
  const { t } = useTranslation()
  const [aberto, setAberto] = useState(false)

  const escolhidas = tasks.filter((task) => selecionadas.includes(task.id))

  const alternar = (id: string) => {
    onChange(selecionadas.includes(id) ? selecionadas.filter((x) => x !== id) : [...selecionadas, id])
  }

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger
        disabled={tasks.length === 0}
        className={cn(
          "flex min-h-8 w-full items-center gap-1.5 rounded-md border bg-transparent px-2 py-1 text-left text-xs transition-colors",
          tasks.length === 0 ? "cursor-not-allowed opacity-60" : "hover:border-ring",
          className,
        )}
      >
        <div className="flex min-w-0 flex-1 flex-wrap gap-1">
          {escolhidas.length === 0 ? (
            <span className="text-muted-foreground">
              {tasks.length === 0 ? t("esteira.semTasksParaDependencia") : t("esteira.selecioneDependencias")}
            </span>
          ) : (
            escolhidas.map((task) => (
              <span
                key={task.id}
                className="flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]"
              >
                <span className="truncate">{task.titulo}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation()
                    alternar(task.id)
                  }}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <XIcon className="size-3" />
                </span>
              </span>
            ))
          )}
        </div>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>

      <PopoverContent className="p-0">
        <ListaTasksBuscavel tasks={tasks} selecionadas={selecionadas} onEscolher={alternar} />
      </PopoverContent>
    </Popover>
  )
}
