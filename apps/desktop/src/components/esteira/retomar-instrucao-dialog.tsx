import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { Esteira, Task } from "@shared/esteira"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useEsteiraStore } from "@/src/stores/esteira-store"

/**
 * Retomar uma task pausada dizendo o que a fase deve fazer diferente: uma
 * informação que faltou, um rumo a corrigir. A fase roda de novo com a
 * instrução como prioridade — sem abrir rodada nova (isso é o "Devolver").
 */
export function RetomarInstrucaoDialog({
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
  const retomarTask = useEsteiraStore((s) => s.retomarTask)
  const [texto, setTexto] = useState("")
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    if (!aberto) return
    setTexto("")
    setErro(null)
  }, [aberto, task?.id])

  if (!task) return null
  const fase = esteira.fases[task.faseAtual ?? 0]

  const retomar = async () => {
    if (!texto.trim() || enviando) return
    setEnviando(true)
    setErro(null)
    try {
      await retomarTask(esteira.id, task.id, texto.trim())
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
        <DialogTitle>{t("esteira.retomarInstrucaoTitulo", { titulo: task.titulo })}</DialogTitle>
        <p className="text-[11px] text-muted-foreground">
          {t("esteira.retomarInstrucaoDica", { fase: fase?.nome ?? "" })}
        </p>

        {task.pausaMotivo === "erro" && task.erro && (
          <p className="max-h-24 overflow-y-auto rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
            {task.erro}
          </p>
        )}

        <Textarea
          autoFocus
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void retomar()
          }}
          rows={5}
          placeholder={t("esteira.retomarInstrucaoPlaceholder")}
          className="text-xs"
        />

        {erro && <p className="text-[11px] text-destructive">{erro}</p>}

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!texto.trim() || enviando} onClick={() => void retomar()}>
            {t("esteira.retomar")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
