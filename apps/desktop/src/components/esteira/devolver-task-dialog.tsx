import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangleIcon } from "lucide-react"
import type { Esteira, Task } from "@shared/esteira"
import { rodadaDaTask } from "@shared/esteira"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { SEM_TASKS, useEsteiraStore } from "@/src/stores/esteira-store"

/**
 * Devolver uma task concluída: o comentário da revisão vira a instrução
 * prioritária de uma rodada nova, que recomeça na fase escolhida e trabalha em
 * cima do que a rodada anterior deixou.
 */
export function DevolverTaskDialog({
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
  const { t } = useTranslation()
  const devolverTask = useEsteiraStore((s) => s.devolverTask)
  const tasks = useEsteiraStore((s) => s.tasksPorEsteira[esteira.id] ?? SEM_TASKS)
  const [texto, setTexto] = useState("")
  const [fase, setFase] = useState(0)
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    if (!aberto) return
    setTexto("")
    setFase(0)
    setErro(null)
  }, [aberto, task?.id])

  if (!task) return null

  // Quem depende desta e já rodou trabalhou em cima da versão anterior: avisa,
  // sem bloquear — às vezes a correção não afeta os dependentes.
  const dependentesRodados = tasks.filter((x) => x.dependeDe.includes(task.id) && x.status !== "pendente")

  const devolver = async () => {
    if (!texto.trim() || enviando) return
    setEnviando(true)
    setErro(null)
    try {
      await devolverTask(esteira.id, task.id, texto.trim(), fase)
      onOpenChange(false)
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err))
    } finally {
      setEnviando(false)
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{t("esteira.devolverTitulo", { titulo: task.titulo })}</DialogTitle>
        <p className="text-[11px] text-muted-foreground">
          {t("esteira.devolverDica", { rodada: rodadaDaTask(task) + 1 })}
        </p>

        <div className="space-y-1">
          <p className="text-xs font-medium">{t("esteira.devolverComentario")}</p>
          <Textarea
            autoFocus
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void devolver()
            }}
            rows={6}
            placeholder={t("esteira.devolverPlaceholder")}
            className="text-xs"
          />
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium">{t("esteira.devolverFase")}</p>
          <select
            value={fase}
            onChange={(e) => setFase(Number(e.target.value))}
            className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
          >
            {esteira.fases.map((f, indice) => (
              <option key={f.id} value={indice} className="bg-popover text-popover-foreground">
                {f.nome}
              </option>
            ))}
          </select>
        </div>

        {dependentesRodados.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-2.5 py-2 text-[11px] text-yellow-700 dark:text-yellow-300">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {t("esteira.devolverDependentes", {
                count: dependentesRodados.length,
                titulos: dependentesRodados.map((x) => x.titulo).join(", "),
              })}
            </span>
          </div>
        )}

        {erro && <p className="text-[11px] text-destructive">{erro}</p>}

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!texto.trim() || enviando} onClick={() => void devolver()}>
            {t("esteira.devolver")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
