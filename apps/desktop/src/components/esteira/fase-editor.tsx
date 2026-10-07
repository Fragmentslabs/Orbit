import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon } from "lucide-react"
import type { ReasoningConfig } from "@shared/chat"
import type { FaseEscolhida, FaseTemplate, FaseTipo, ToolPermitida } from "@shared/esteira"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ModelField } from "@/src/components/model-field"
import { ThinkingMenu } from "@/src/components/thinking-menu"
import { useEsteiraStore } from "@/src/stores/esteira-store"
import { useProviderStore } from "@/src/stores/provider-store"
import type { DefaultModel } from "@/src/stores/model-mode-prefs"
import { cn } from "@/lib/utils"

const CAPACIDADES: ToolPermitida[] = ["leitura", "edit", "shell", "browser", "memoria"]
const TIPOS: FaseTipo[] = ["desenvolvimento", "validacao", "seguranca", "revisao", "infra", "generico"]

/**
 * Onde salvar a fase editada:
 *  - "esteira": só a cópia desta esteira (D4), sem contaminar outras pipelines;
 *  - "original": também o template de origem — vale para as próximas esteiras;
 *  - "nova": vira um template novo do usuário (aparece no "Adicionar fase").
 */
export type DestinoFase = "esteira" | "original" | "nova"

/** "Modelo · nível" para mostrar a fase sem abrir o editor. */
export function useRotuloModelo(
  providerId: string | undefined,
  modelId: string | undefined,
  reasoning: ReasoningConfig | null | undefined,
): string | null {
  const { t } = useTranslation()
  const model = useProviderStore((s) => (providerId && modelId ? s.catalog[providerId]?.models[modelId] : undefined))
  if (!providerId || !modelId) return null
  const nome = model?.name ?? modelId
  if (!reasoning?.enabled) return nome
  const variante = reasoning.variantId
  const nivel = variante
    ? t(`reasoning.variants.${variante}`, { defaultValue: model?.variants?.find((v) => v.id === variante)?.label ?? variante })
    : t("reasoning.variants.thinking")
  return `${nome} · ${nivel}`
}

/**
 * Grava o template conforme o destino e devolve a fase já apontando para ele.
 * O modelo não vai para o template: ele é escolha de cada esteira.
 */
export function useSalvarTemplateDaFase() {
  const salvarTemplate = useEsteiraStore((s) => s.salvarTemplate)
  const templates = useEsteiraStore((s) => s.templates)
  return async (fase: FaseEscolhida, destino: DestinoFase): Promise<FaseEscolhida> => {
    if (destino === "esteira") return fase
    if (destino === "original" && !fase.templateId) return fase
    const id = destino === "nova" ? `usr_${Date.now().toString(36)}` : fase.templateId!
    const original = templates.find((tpl) => tpl.id === id)
    const template: FaseTemplate = {
      id,
      nome: fase.nome,
      descricao: fase.descricao,
      prompt: fase.prompt,
      tools: fase.tools,
      tipo: fase.tipo,
      // Mantém a fase entre as sugeridas se já era, para o padrão não sumir
      padrao: original?.padrao ?? false,
    }
    await salvarTemplate(template)
    return { ...fase, templateId: id }
  }
}

/**
 * Editor de fase: nome, descrição, modelo + raciocínio, prompt e capacidades.
 * Salvar fica num botão dividido: o principal mexe só nesta esteira; o chevron
 * leva a "salvar na original" e "salvar como nova fase" (ver DestinoFase).
 */
export function FaseEditor({
  fase,
  aberto,
  modeloPadrao,
  reasoningPadrao,
  onOpenChange,
  onSalvar,
  herdaPadrao = false,
}: {
  /** Fase em edição; ausente = criando uma do zero */
  fase: FaseEscolhida | null
  aberto: boolean
  /** Modelo/raciocínio da esteira — o que a fase usa quando não tem o seu */
  modeloPadrao: DefaultModel | null
  reasoningPadrao: ReasoningConfig | null
  /**
   * Na criação da esteira, a fase segue o "Modelo padrão" até ganhar um
   * próprio — e pode voltar a segui-lo pelo link "Usar padrão".
   */
  herdaPadrao?: boolean
  onOpenChange: (aberto: boolean) => void
  onSalvar: (fase: FaseEscolhida, destino: DestinoFase) => void
}) {
  const { t } = useTranslation()
  const [nome, setNome] = useState("")
  const [descricao, setDescricao] = useState("")
  const [prompt, setPrompt] = useState("")
  const [tools, setTools] = useState<ToolPermitida[]>(["leitura"])
  const [tipo, setTipo] = useState<FaseTipo>("generico")
  // Modelo próprio da fase. Enquanto não há um (`proprio` false), o editor
  // mostra o padrão e a fase é salva sem modelo — segue o da esteira.
  const [proprio, setProprio] = useState(false)
  const [modelo, setModelo] = useState<DefaultModel | null>(null)
  const [reasoning, setReasoning] = useState<ReasoningConfig | null>(null)

  // Semeia só na abertura (e ao trocar de fase): o padrão chega como objeto
  // novo a cada render e, como dependência, apagaria o que está sendo digitado.
  useEffect(() => {
    if (!aberto) return
    setNome(fase?.nome ?? "")
    setDescricao(fase?.descricao ?? "")
    setPrompt(fase?.prompt ?? "")
    setTools(fase?.tools ?? ["leitura", "edit", "shell"])
    setTipo(fase?.tipo ?? "generico")
    const temProprio = !!fase?.providerId && !!fase.modelId
    setProprio(temProprio)
    setModelo(temProprio ? { providerId: fase!.providerId!, modelId: fase!.modelId! } : null)
    setReasoning(temProprio ? (fase?.reasoning ?? null) : null)
  }, [aberto, fase])

  const modeloVisivel = proprio ? modelo : modeloPadrao
  const reasoningVisivel = proprio ? reasoning : reasoningPadrao

  const alternarTool = (tool: ToolPermitida) => {
    setTools((atual) => (atual.includes(tool) ? atual.filter((x) => x !== tool) : [...atual, tool]))
  }

  const valido = nome.trim().length > 0 && prompt.trim().length > 0

  const salvar = (destino: DestinoFase) => {
    if (!valido) return
    onSalvar(
      {
        templateId: fase?.templateId,
        nome: nome.trim(),
        descricao: descricao.trim(),
        prompt: prompt.trim(),
        tools,
        tipo,
        // Sem modelo próprio a fase sai sem os campos: quem salva usa o padrão.
        ...(proprio && modelo ? { providerId: modelo.providerId, modelId: modelo.modelId, reasoning } : {}),
      },
      destino,
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
            <ModelField
              label={t("esteira.faseModelo")}
              value={modeloVisivel}
              onChange={(m) => {
                if (!m) return
                setModelo(m)
                // Outro modelo, outros níveis: volta a desligado (como nas
                // Preferências); o mesmo modelo mantém o nível que já via.
                const mesmo = m.providerId === modeloVisivel?.providerId && m.modelId === modeloVisivel?.modelId
                setReasoning(mesmo ? reasoningVisivel : null)
                setProprio(true)
              }}
              action={
                <>
                  <ThinkingMenu
                    model={modeloVisivel}
                    value={reasoningVisivel}
                    onChange={(r) => {
                      setModelo(modeloVisivel)
                      setReasoning(r)
                      setProprio(true)
                    }}
                  />
                  {herdaPadrao && proprio && (
                    <button
                      type="button"
                      onClick={() => setProprio(false)}
                      className="ml-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {t("esteira.usarPadrao")}
                    </button>
                  )}
                </>
              }
            />
            {herdaPadrao && !proprio && (
              <p className="text-[11px] text-muted-foreground">{t("esteira.seguePadrao")}</p>
            )}
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium">{t("esteira.faseTipo")}</p>
            <p className="text-[11px] text-muted-foreground">{t("esteira.faseTipoDica")}</p>
            <select
              value={tipo}
              onChange={(e) => setTipo(e.target.value as FaseTipo)}
              className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
            >
              {TIPOS.map((tipoOpcao) => (
                <option key={tipoOpcao} value={tipoOpcao} className="bg-popover text-popover-foreground">
                  {t(`esteira.tipo.${tipoOpcao}`)}
                </option>
              ))}
            </select>
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
          <div className="flex">
            <Button size="sm" className="rounded-r-none" disabled={!valido} onClick={() => salvar("esteira")}>
              {t("esteira.salvarNestaEsteira")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={!valido}
                aria-label={t("esteira.maisOpcoesSalvar")}
                render={<Button size="sm" className="rounded-l-none border-l border-primary-foreground/20 px-1.5" />}
              >
                <ChevronDownIcon className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="min-w-52">
                <DropdownMenuItem disabled={!fase?.templateId} onClick={() => salvar("original")}>
                  {t("esteira.salvarNaOriginal")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => salvar("nova")}>
                  {t("esteira.salvarComoNovaFase")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
