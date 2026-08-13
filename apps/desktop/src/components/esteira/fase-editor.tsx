import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { FaseEscolhida, ToolPermitida } from "@shared/esteira"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const CAPACIDADES: ToolPermitida[] = ["leitura", "edit", "shell", "browser", "memoria"]

/**
 * Editor de fase: nome, descrição, prompt e capacidades.
 *
 * Salvar tem dois destinos, e a diferença importa: "só nesta esteira" mexe na
 * cópia (D4) e não contamina outras pipelines; "salvar como padrão" grava o
 * template mestre e passa a valer para toda esteira criada dali em diante.
 */
export function FaseEditor({
  fase,
  aberto,
  podeSalvarPadrao,
  onOpenChange,
  onSalvar,
}: {
  /** Fase em edição; ausente = criando uma do zero */
  fase: FaseEscolhida | null
  aberto: boolean
  /** false quando a fase não veio de template (não há padrão a atualizar) */
  podeSalvarPadrao: boolean
  onOpenChange: (aberto: boolean) => void
  onSalvar: (fase: FaseEscolhida, comoPadrao: boolean) => void
}) {
  const { t } = useTranslation()
  const [nome, setNome] = useState("")
  const [descricao, setDescricao] = useState("")
  const [prompt, setPrompt] = useState("")
  const [tools, setTools] = useState<ToolPermitida[]>(["leitura"])

  useEffect(() => {
    if (!aberto) return
    setNome(fase?.nome ?? "")
    setDescricao(fase?.descricao ?? "")
    setPrompt(fase?.prompt ?? "")
    setTools(fase?.tools ?? ["leitura", "edit", "shell"])
  }, [aberto, fase])

  const alternarTool = (tool: ToolPermitida) => {
    setTools((atual) => (atual.includes(tool) ? atual.filter((x) => x !== tool) : [...atual, tool]))
  }

  const valido = nome.trim().length > 0 && prompt.trim().length > 0

  const salvar = (comoPadrao: boolean) => {
    if (!valido) return
    onSalvar(
      {
        templateId: fase?.templateId,
        nome: nome.trim(),
        descricao: descricao.trim(),
        prompt: prompt.trim(),
        tools,
      },
      comoPadrao,
    )
    onOpenChange(false)
  }

  return (
    <Dialog open={aberto} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{fase ? t("esteira.editarFase") : t("esteira.novaFase")}</DialogTitle>

        <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("esteira.faseNome")}</p>
            <Input value={nome} onChange={(e) => setNome(e.target.value)} className="h-8 text-sm" />
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium">{t("esteira.faseDescricao")}</p>
            <Input
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              className="h-8 text-sm"
              placeholder={t("esteira.faseDescricaoDica")}
            />
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium">{t("esteira.fasePrompt")}</p>
            <p className="text-[11px] text-muted-foreground">{t("esteira.fasePromptDica")}</p>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={12}
              className="w-full resize-y rounded-md border bg-transparent px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus-visible:border-ring"
            />
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium">{t("esteira.faseCapacidades")}</p>
            <div className="flex flex-wrap gap-1.5">
              {CAPACIDADES.map((tool) => (
                <button
                  key={tool}
                  type="button"
                  onClick={() => alternarTool(tool)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                    tools.includes(tool)
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {t(`esteira.capacidade.${tool}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          {podeSalvarPadrao && (
            <Button variant="outline" size="sm" disabled={!valido} onClick={() => salvar(true)}>
              {t("esteira.salvarComoPadrao")}
            </Button>
          )}
          <Button size="sm" disabled={!valido} onClick={() => salvar(false)}>
            {t("esteira.salvarNestaEsteira")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
