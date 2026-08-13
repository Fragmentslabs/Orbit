import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { GripVerticalIcon, PencilIcon, PlusIcon, XIcon } from "lucide-react"
import type { Esteira, FaseEscolhida, FaseTemplate } from "@shared/esteira"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FolderSelector } from "@/src/components/folder-selector"
import { BranchSelector } from "@/src/components/branch-selector"
import { ModelPicker } from "@/src/components/model-picker"
import { useEsteiraStore } from "@/src/stores/esteira-store"
import { useSessionModel, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { cn } from "@/lib/utils"
import { FaseEditor } from "./fase-editor"

/**
 * Modal "Nova Esteira" (§3).
 *
 * Chave de modelo própria: o ModelPicker do input guarda a escolha por sessão,
 * então a esteira usa uma chave sintética — assim o seletor é literalmente o
 * mesmo componente do chat, sem trocar o modelo de nenhuma conversa.
 */
const CHAVE_MODELO = "esteira:nova"

export function EsteiraCreateDialog({
  aberto,
  onOpenChange,
  projetoId,
  onCriada,
  editando: esteiraEmEdicao,
}: {
  aberto: boolean
  onOpenChange: (aberto: boolean) => void
  /** Projeto existente; ausente = o projeto é criado junto com a esteira */
  projetoId?: string
  /** Abre a esteira recém-criada direto no board */
  onCriada?: (esteiraId: string) => void
  /** Esteira existente — o mesmo modal vira edição */
  editando?: Esteira | null
}) {
  const { t } = useTranslation()
  const criarProjeto = useEsteiraStore((s) => s.criarProjeto)
  const criarEsteira = useEsteiraStore((s) => s.criarEsteira)
  const salvarTemplate = useEsteiraStore((s) => s.salvarTemplate)
  const templates = useEsteiraStore((s) => s.templates)
  const modelo = useSessionModel(CHAVE_MODELO)

  const [nome, setNome] = useState("")
  const [pastas, setPastas] = useState<string[]>([])
  const [fases, setFases] = useState<FaseEscolhida[]>([])
  const [pushAoFinal, setPushAoFinal] = useState(false)
  const [prints, setPrints] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [editando, setEditando] = useState<{ indice: number | null; fase: FaseEscolhida | null } | null>(null)

  const atualizarEsteira = useEsteiraStore((s) => s.atualizarEsteira)
  const atualizarProjeto = useEsteiraStore((s) => s.atualizarProjeto)
  const esteiraEditando = esteiraEmEdicao ?? null
  const projetoAlvo = esteiraEditando?.projetoId ?? projetoId
  const projetoExistente = useEsteiraStore((s) => s.projetos.find((p) => p.id === projetoAlvo))

  // Fases embutidas tem nome/descricao traduzidos (o prompt segue em ingles,
  // como o resto dos prompts do app). As do usuario usam o que ele escreveu.
  const rotulo = (tpl: FaseTemplate) =>
    tpl.i18nKey && !tpl.custom
      ? { nome: t(`esteira.fase.${tpl.i18nKey}.nome`), descricao: t(`esteira.fase.${tpl.i18nKey}.descricao`) }
      : { nome: tpl.nome, descricao: tpl.descricao }

  const doTemplate = (tpl: FaseTemplate): FaseEscolhida => ({
    templateId: tpl.id,
    ...rotulo(tpl),
    prompt: tpl.prompt,
    tools: [...tpl.tools],
  })

  // Estado inicial a cada abertura: só as fases padrão entram; as demais ficam
  // atrás do "+" para o modal não abrir com uma parede de opções.
  useEffect(() => {
    if (!aberto) return
    setPastas(projetoExistente?.pastas ?? [])
    if (esteiraEditando) {
      setNome(esteiraEditando.nome)
      setPushAoFinal(esteiraEditando.pushAoFinal)
      setPrints(!!esteiraEditando.printsDoResultado)
      // Edição parte das fases REAIS da esteira (já são cópias, D4), não dos
      // templates: o usuário pode tê-las editado só para esta pipeline.
      setFases(
        esteiraEditando.fases
          .filter((f) => !templates.some((tpl) => tpl.fixa && tpl.nome === f.nome))
          .map((f) => ({
            templateId: templates.find((tpl) => tpl.nome === f.nome)?.id,
            nome: f.nome,
            descricao: f.descricao,
            prompt: f.prompt,
            tools: [...f.tools],
          })),
      )
      return
    }
    setNome("")
    setPushAoFinal(false)
    setPrints(false)
    setFases(templates.filter((tpl) => tpl.padrao && !tpl.fixa).map(doTemplate))
  }, [aberto, templates, projetoExistente, esteiraEditando])

  const disponiveis = templates.filter(
    (tpl) => !tpl.fixa && !fases.some((f) => f.templateId === tpl.id),
  )

  const mover = useCallback((de: number, para: number) => {
    setFases((atual) => {
      if (de === para || de < 0 || para < 0 || de >= atual.length || para >= atual.length) return atual
      const proximo = [...atual]
      const [movida] = proximo.splice(de, 1)
      proximo.splice(para, 0, movida)
      return proximo
    })
  }, [])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const aoSoltar = (evento: DragEndEvent) => {
    const de = Number(String(evento.active.id).replace("fase-", ""))
    const para = Number(String(evento.over?.id ?? "").replace("alvo-", ""))
    if (Number.isInteger(de) && Number.isInteger(para)) mover(de, para)
  }

  const salvarFase = async (fase: FaseEscolhida, comoPadrao: boolean) => {
    const indice = editando?.indice ?? null
    setFases((atual) => (indice == null ? [...atual, fase] : atual.map((f, i) => (i === indice ? fase : f))))
    if (comoPadrao && fase.templateId) {
      await salvarTemplate({
        id: fase.templateId,
        nome: fase.nome,
        descricao: fase.descricao,
        prompt: fase.prompt,
        tools: fase.tools,
        // Mantém a fase entre as sugeridas se já era, para o padrão não sumir
        padrao: templates.find((tpl) => tpl.id === fase.templateId)?.padrao ?? false,
      })
    }
    setEditando(null)
  }

  // Pasta é obrigatória: sem repositório principal não há onde a esteira
  // trabalhar, e a task só falharia na primeira fase.
  const podeCriar = nome.trim().length > 0 && fases.length > 0 && !!modelo && pastas.length > 0

  const criar = async () => {
    if (!podeCriar || salvando || !modelo) return
    setSalvando(true)
    try {
      if (esteiraEditando) {
        // Edição não recria a esteira: mantém id, tasks e histórico. As fases
        // viram FaseConfig preservando o modelo já configurado por fase.
        await atualizarEsteira(esteiraEditando.id, {
          nome: nome.trim(),
          pushAoFinal,
          printsDoResultado: prints,
          fases: fases.map((fase, ordem) => {
            const anterior = esteiraEditando.fases[ordem]
            return {
              id: anterior?.id ?? `fase_${ordem}_${Date.now().toString(36)}`,
              nome: fase.nome,
              descricao: fase.descricao,
              prompt: fase.prompt,
              providerId: anterior?.providerId ?? modelo.providerId,
              modelId: anterior?.modelId ?? modelo.modelId,
              thinkingNivel: anterior?.thinkingNivel ?? 0,
              tools: [...fase.tools],
              ordem,
            }
          }),
        })
        if (projetoAlvo) await atualizarProjeto(projetoAlvo, { pastas })
        onOpenChange(false)
        return
      }
      // O projeto (D1) é o dono das pastas. Como o fluxo é "criar esteira e
      // escolher o repositório", ele nasce junto, com o mesmo nome.
      const alvo = projetoId ?? (await criarProjeto(nome.trim(), pastas)).id
      const esteira = await criarEsteira({
        projetoId: alvo,
        nome: nome.trim(),
        fases,
        providerId: modelo.providerId,
        modelId: modelo.modelId,
        pushAoFinal,
        printsDoResultado: prints,
      })
      // Recentes são globais e compartilhados com os chats. O modelo entra na
      // lista aqui, e não ao ser escolhido: o critério do app é "usado de
      // verdade" (nos chats, ao concluir uma resposta) — criar a esteira é o
      // momento em que ele passa a ser o modelo das fases.
      useSessionModelPrefs.getState().markUsed(modelo.providerId, modelo.modelId)
      onOpenChange(false)
      onCriada?.(esteira.id)
    } finally {
      setSalvando(false)
    }
  }

  return (
    <>
      <Dialog open={aberto} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>{esteiraEditando ? t("esteira.editarEsteira") : t("esteira.novaEsteira")}</DialogTitle>

          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <Campo rotulo={t("esteira.nomeEsteira")}>
              <Input
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                className="h-8 text-sm"
                placeholder={t("esteira.nomeExemplo")}
              />
            </Campo>

            <Campo rotulo={t("esteira.pastas")} dica={t("esteira.pastasDica")}>
              <div className="flex flex-wrap items-center gap-2">
                <FolderSelector folders={pastas} onFoldersChange={setPastas} />
                {/* Badge de branch só depois da pasta: antes dela não há repo
                    para listar, e o seletor abriria vazio. */}
                {pastas[0] && <BranchSelector repoPath={pastas[0]} />}
              </div>
              {pastas.length > 0 && (
                <p className="mt-1 truncate text-[11px] text-muted-foreground">
                  {t("esteira.repositorioPrincipal")}: <span className="text-foreground">{pastas[0]}</span>
                </p>
              )}
            </Campo>

            <Campo rotulo={t("esteira.modeloPadrao")} dica={t("esteira.modeloDica")}>
              <ModelPicker sessionId={CHAVE_MODELO} />
            </Campo>

            <Campo rotulo={t("esteira.fases")} dica={t("esteira.fasesDica")}>
              <DndContext sensors={sensors} onDragEnd={aoSoltar}>
                <div className="space-y-1">
                  {fases.map((fase, indice) => (
                    <FaseLinha
                      key={`${fase.templateId ?? "custom"}-${indice}`}
                      fase={fase}
                      indice={indice}
                      onEditar={() => setEditando({ indice, fase })}
                      onRemover={() => setFases((atual) => atual.filter((_, i) => i !== indice))}
                    />
                  ))}
                </div>
              </DndContext>

              <div className="mt-1.5">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <PlusIcon className="size-3" />
                    {t("esteira.adicionarFase")}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-56">
                    {disponiveis.map((tpl) => (
                      <DropdownMenuItem key={tpl.id} onClick={() => setFases((atual) => [...atual, doTemplate(tpl)])}>
                        <div className="min-w-0">
                          <p className="truncate text-xs">{rotulo(tpl).nome}</p>
                          <p className="truncate text-[10px] text-muted-foreground">{rotulo(tpl).descricao}</p>
                        </div>
                      </DropdownMenuItem>
                    ))}
                    {disponiveis.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuItem onClick={() => setEditando({ indice: null, fase: null })}>
                      <PlusIcon className="size-3.5" />
                      {t("esteira.criarFase")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </Campo>

            <div className="space-y-2">
              <label className="flex cursor-pointer items-center gap-2">
                <Switch checked={pushAoFinal} onCheckedChange={setPushAoFinal} />
                <span className="text-xs text-foreground">{t("esteira.push")}</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <Switch checked={prints} onCheckedChange={setPrints} />
                <span className="text-xs text-foreground">{t("esteira.prints")}</span>
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={!podeCriar || salvando} onClick={() => void criar()}>
              {esteiraEditando ? t("esteira.salvar") : t("esteira.criar")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <FaseEditor
        fase={editando?.fase ?? null}
        aberto={!!editando}
        podeSalvarPadrao={!!editando?.fase?.templateId}
        onOpenChange={(v) => !v && setEditando(null)}
        onSalvar={(fase, comoPadrao) => void salvarFase(fase, comoPadrao)}
      />
    </>
  )
}

function Campo({ rotulo, dica, children }: { rotulo: string; dica?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">{rotulo}</p>
      {dica && <p className="text-[11px] text-muted-foreground">{dica}</p>}
      {children}
    </div>
  )
}

/** Linha arrastável da fase: a alça move, o resto abre o editor. */
function FaseLinha({
  fase,
  indice,
  onEditar,
  onRemover,
}: {
  fase: FaseEscolhida
  indice: number
  onEditar: () => void
  onRemover: () => void
}) {
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id: `fase-${indice}` })
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `alvo-${indice}` })

  return (
    <div
      ref={setDropRef}
      className={cn(
        "flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 transition-colors",
        isDragging && "opacity-40",
        isOver && "border-primary",
      )}
    >
      <button
        ref={setDragRef}
        {...attributes}
        {...listeners}
        type="button"
        className="shrink-0 cursor-grab text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{fase.nome}</p>
        <p className="truncate text-[11px] text-muted-foreground">{fase.descricao}</p>
      </div>
      <button
        type="button"
        onClick={onEditar}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <PencilIcon className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onRemover}
        className="shrink-0 text-muted-foreground hover:text-destructive"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}
