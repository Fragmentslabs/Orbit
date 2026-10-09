import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { GripVerticalIcon, PencilIcon, PlusIcon, Settings2Icon, XIcon } from "lucide-react"
import type { ReasoningConfig } from "@shared/chat"
import type { Esteira, FaseEscolhida, FaseTemplate } from "@shared/esteira"
import { ESTEIRA_COMMIT_PROMPT_PADRAO } from "@shared/esteira"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
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
import { ThinkingMenu } from "@/src/components/thinking-menu"
import { useEsteiraStore } from "@/src/stores/esteira-store"
import { useReasoningPrefsStore } from "@/src/stores/reasoning-prefs"
import { useSessionModel, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { cn } from "@/lib/utils"
import { FaseEditor, useRotuloModelo, useSalvarTemplateDaFase, type DestinoFase } from "./fase-editor"

/**
 * Modal "Nova Esteira" (§3).
 *
 * Chave de modelo própria: o ModelPicker do input guarda a escolha por sessão,
 * então a esteira usa uma chave sintética — assim o seletor é literalmente o
 * mesmo componente do chat, sem trocar o modelo de nenhuma conversa.
 */
const CHAVE_MODELO = "esteira:nova"

/** Nível de raciocínio que o usuário já usa com o modelo (o mesmo do chat). */
function nivelSalvo(providerId: string, modelId: string): ReasoningConfig | null {
  const pref = useReasoningPrefsStore.getState().prefs[`${providerId}/${modelId}`]
  return pref?.enabled ? { enabled: true, variantId: pref.variantId } : null
}

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
  const removerTemplate = useEsteiraStore((s) => s.removerTemplate)
  const templates = useEsteiraStore((s) => s.templates)
  const salvarTemplateDaFase = useSalvarTemplateDaFase()
  const modelo = useSessionModel(CHAVE_MODELO)
  const chaveModelo = modelo ? `${modelo.providerId}/${modelo.modelId}` : null

  const [nome, setNome] = useState("")
  const [pastas, setPastas] = useState<string[]>([])
  const [fases, setFases] = useState<FaseEscolhida[]>([])
  const [pushAoFinal, setPushAoFinal] = useState(false)
  const [commitAoFinal, setCommitAoFinal] = useState(true)
  const [commitPrompt, setCommitPrompt] = useState("")
  const [promptAberto, setPromptAberto] = useState(false)
  const [prints, setPrints] = useState(false)
  const [worktreePorTask, setWorktreePorTask] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [editando, setEditando] = useState<{ indice: number | null; fase: FaseEscolhida | null } | null>(null)
  const [reasoningPadrao, setReasoningPadrao] = useState<ReasoningConfig | null>(null)
  // Último modelo padrão visto: ao trocá-lo, o raciocínio padrão recomeça.
  const [modeloAlinhado, setModeloAlinhado] = useState<string | null>(null)
  const [menuFasesAberto, setMenuFasesAberto] = useState(false)
  const [excluindo, setExcluindo] = useState<FaseTemplate | null>(null)

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
    tipo: tpl.tipo,
  })

  // Estado inicial a cada abertura: só as fases padrão entram; as demais ficam
  // atrás do "+" para o modal não abrir com uma parede de opções.
  // Uma vez por abertura: salvar/excluir um template muda `templates`
  // com o modal aberto, e re-semear apagaria o que o usuário já escolheu. Só
  // espera os templates chegarem (carga assíncrona) antes de dar por semeado.
  const semeado = useRef(false)
  useEffect(() => {
    if (!aberto) {
      semeado.current = false
      return
    }
    if (semeado.current) return
    semeado.current = !!esteiraEditando || templates.length > 0
    setPastas(projetoExistente?.pastas ?? [])
    if (esteiraEditando) {
      setNome(esteiraEditando.nome)
      setPushAoFinal(esteiraEditando.pushAoFinal)
      setCommitAoFinal(esteiraEditando.commitAoFinal !== false)
      setCommitPrompt(esteiraEditando.commitPrompt ?? "")
      setPrints(!!esteiraEditando.printsDoResultado)
      setWorktreePorTask(!!esteiraEditando.worktreePorTask)
      // Edição parte das fases REAIS da esteira (já são cópias, D4), não dos
      // templates: o usuário pode tê-las editado só para esta pipeline. Cada
      // uma leva o modelo e o raciocínio que já tem.
      setFases(
        esteiraEditando.fases.map((f) => ({
          templateId: f.templateId ?? templates.find((tpl) => tpl.nome === f.nome)?.id,
          nome: f.nome,
          descricao: f.descricao,
          prompt: f.prompt,
          tools: [...f.tools],
          tipo: f.tipo ?? "generico",
          providerId: f.providerId,
          modelId: f.modelId,
          reasoning: f.reasoning ?? null,
        })),
      )
      return
    }
    setModeloAlinhado(chaveModelo)
    setReasoningPadrao(modelo ? nivelSalvo(modelo.providerId, modelo.modelId) : null)
    setNome("")
    setPushAoFinal(false)
    setCommitAoFinal(true)
    setCommitPrompt("")
    setPrints(false)
    setWorktreePorTask(false)
    setFases(templates.filter((tpl) => tpl.padrao).map(doTemplate))
    // O reset é disparado pela ABERTURA do modal; doTemplate é um helper
    // recriado a cada render e como dep limparia o formulário sozinho.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto, templates, projetoExistente, esteiraEditando])

  // Troca do "Modelo padrão" (só na criação): o raciocínio parte do nível que
  // o usuário já usa com esse modelo. Fases com modelo próprio não mudam. Só
  // reage ao modelo (não à abertura): no commit da abertura o estado ainda é
  // o da sessão anterior.
  useEffect(() => {
    if (!aberto || esteiraEditando || !modelo || chaveModelo === modeloAlinhado) return
    setModeloAlinhado(chaveModelo)
    setReasoningPadrao(nivelSalvo(modelo.providerId, modelo.modelId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaveModelo])

  // O que uma fase sem modelo próprio usa. Na criação, o "Modelo padrão"; na
  // edição (onde ele não aparece — cada fase já tem o seu), o da primeira
  // fase, para quem entrar pelo "Adicionar fase".
  const primeira = esteiraEditando?.fases[0]
  const modeloDasFases = esteiraEditando
    ? primeira
      ? { providerId: primeira.providerId, modelId: primeira.modelId }
      : null
    : (modelo ?? null)
  const reasoningDasFases = esteiraEditando ? (primeira?.reasoning ?? null) : reasoningPadrao

  const disponiveis = templates.filter(
    (tpl) => !fases.some((f) => f.templateId === tpl.id),
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

  const salvarFase = async (editada: FaseEscolhida, destino: DestinoFase) => {
    const indice = editando?.indice ?? null
    setEditando(null)
    const fase = await salvarTemplateDaFase(editada, destino)
    setFases((atual) => (indice == null ? [...atual, fase] : atual.map((f, i) => (i === indice ? fase : f))))
  }

  // Pasta é obrigatória: sem repositório principal não há onde a esteira
  // trabalhar, e a task só falharia na primeira fase.
  const podeCriar = nome.trim().length > 0 && fases.length > 0 && !!modeloDasFases && pastas.length > 0

  // Push depende do commit final: desligar o commit desliga o push junto —
  // um push sem o estado completo commitado subiria trabalho incompleto.
  const aoMudarCommit = (ligado: boolean) => {
    setCommitAoFinal(ligado)
    if (!ligado) setPushAoFinal(false)
  }

  const criar = async () => {
    if (!podeCriar || salvando || !modeloDasFases) return
    setSalvando(true)
    try {
      if (esteiraEditando) {
        // Edição não recria a esteira: mantém id, tasks e histórico. Cada fase
        // usa o modelo próprio quando tem; senão, o "Modelo padrão".
        await atualizarEsteira(esteiraEditando.id, {
          nome: nome.trim(),
          pushAoFinal,
          commitAoFinal,
          ...(commitPrompt.trim() ? { commitPrompt: commitPrompt.trim() } : { commitPrompt: "" }),
          printsDoResultado: prints,
          worktreePorTask,
          fases: fases.map((fase, ordem) => {
            const anterior = esteiraEditando.fases[ordem]
            return {
              id: anterior?.id ?? `fase_${ordem}_${Date.now().toString(36)}`,
              nome: fase.nome,
              descricao: fase.descricao,
              prompt: fase.prompt,
              providerId: fase.providerId && fase.modelId ? fase.providerId : modeloDasFases.providerId,
              modelId: fase.providerId && fase.modelId ? fase.modelId : modeloDasFases.modelId,
              thinkingNivel: anterior?.thinkingNivel ?? 0,
              reasoning: fase.providerId && fase.modelId ? (fase.reasoning ?? null) : reasoningDasFases,
              ...(fase.templateId ? { templateId: fase.templateId } : {}),
              tools: [...fase.tools],
              tipo: fase.tipo,
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
        providerId: modeloDasFases.providerId,
        modelId: modeloDasFases.modelId,
        reasoning: reasoningPadrao,
        pushAoFinal,
        commitAoFinal,
        ...(commitPrompt.trim() ? { commitPrompt: commitPrompt.trim() } : {}),
        printsDoResultado: prints,
        worktreePorTask,
      })
      // Recentes são globais e compartilhados com os chats. O modelo entra na
      // lista aqui, e não ao ser escolhido: o critério do app é "usado de
      // verdade" (nos chats, ao concluir uma resposta) — criar a esteira é o
      // momento em que ele passa a ser o modelo das fases.
      useSessionModelPrefs.getState().markUsed(modeloDasFases.providerId, modeloDasFases.modelId)
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

            {!esteiraEditando && (
            <Campo rotulo={t("esteira.modeloPadrao")} dica={t("esteira.modeloDica")}>
              {/* Trigger com cara de campo de formulário (mesmo visual do
                  Input), mas abrindo o seletor real — que inclui os recentes.
                  Ao lado, o nível de raciocínio (como nas Preferências). */}
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <ModelPicker
                    sessionId={CHAVE_MODELO}
                    triggerClassName="w-full justify-start gap-1.5 rounded-md border border-input bg-input/20 px-2 text-sm font-normal shadow-none hover:bg-accent/40 dark:bg-input/30 md:text-xs/relaxed"
                  />
                </div>
                <ThinkingMenu model={modelo ?? null} value={reasoningPadrao} onChange={setReasoningPadrao} />
              </div>
            </Campo>
            )}

            <Campo rotulo={t("esteira.fases")} dica={t("esteira.fasesDica")}>
              <DndContext sensors={sensors} onDragEnd={aoSoltar}>
                <div className="space-y-1">
                  {fases.map((fase, indice) => (
                    <FaseLinha
                      key={`${fase.templateId ?? "custom"}-${indice}`}
                      fase={fase}
                      indice={indice}
                      modeloPadrao={modeloDasFases}
                      reasoningPadrao={reasoningDasFases}
                      mostrarPadrao={!esteiraEditando}
                      onEditar={() => setEditando({ indice, fase })}
                      onRemover={() => setFases((atual) => atual.filter((_, i) => i !== indice))}
                    />
                  ))}
                </div>
              </DndContext>

              <div className="mt-1.5">
                <DropdownMenu open={menuFasesAberto} onOpenChange={setMenuFasesAberto}>
                  <DropdownMenuTrigger
                    className="flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <PlusIcon className="size-3" />
                    {t("esteira.adicionarFase")}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-56">
                    {disponiveis.map((tpl) => (
                      <DropdownMenuItem key={tpl.id} onClick={() => setFases((atual) => [...atual, doTemplate(tpl)])}>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs">{rotulo(tpl).nome}</p>
                          <p className="truncate text-[10px] text-muted-foreground">{rotulo(tpl).descricao}</p>
                        </div>
                        {/* Só as criadas pelo usuário saem; as embutidas são do app. */}
                        {tpl.doUsuario && (
                          <button
                            type="button"
                            aria-label={t("esteira.excluirFase")}
                            title={t("esteira.excluirFase")}
                            onClick={(e) => {
                              e.stopPropagation()
                              e.preventDefault()
                              setMenuFasesAberto(false)
                              setExcluindo(tpl)
                            }}
                            className="ml-2 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <XIcon className="size-3" />
                          </button>
                        )}
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
              {/* Worktree por task: cada task num branch e numa cópia próprios.
                  Vale para tasks que ainda não começaram — as em andamento
                  seguem onde estão. */}
              <label className="flex cursor-pointer items-start gap-2">
                <Switch checked={worktreePorTask} onCheckedChange={setWorktreePorTask} className="mt-0.5" />
                <span>
                  <span className="block text-xs text-foreground">{t("esteira.worktreePorTask")}</span>
                  <span className="block text-[11px] text-muted-foreground">{t("esteira.worktreePorTaskDica")}</span>
                </span>
              </label>
              <div className="flex items-center gap-2">
                <Switch checked={commitAoFinal} onCheckedChange={aoMudarCommit} />
                <span className="text-xs text-foreground">{t("esteira.commit")}</span>
                <button
                  type="button"
                  onClick={() => setPromptAberto(true)}
                  title={t("esteira.commitPromptTitulo")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Settings2Icon className="size-3.5" />
                </button>
              </div>
              <label className="flex cursor-pointer items-center gap-2">
                {/* Push depende do commit final: sem ele, o push subiria um
                    branch sem o estado completo da task. */}
                <Switch
                  checked={pushAoFinal}
                  onCheckedChange={setPushAoFinal}
                  disabled={!commitAoFinal}
                />
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
        modeloPadrao={modeloDasFases}
        reasoningPadrao={reasoningDasFases}
        herdaPadrao={!esteiraEditando}
        onOpenChange={(v) => !v && setEditando(null)}
        onSalvar={(fase, destino) => void salvarFase(fase, destino)}
      />

      <ConfirmDialog
        open={!!excluindo}
        onOpenChange={(v) => !v && setExcluindo(null)}
        title={t("esteira.excluirFaseTitulo")}
        description={t("esteira.excluirFaseConfirmar", { nome: excluindo?.nome ?? "" })}
        confirmLabel={t("esteira.excluirFase")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={() => excluindo && void removerTemplate(excluindo.id)}
      />

      {/* Prompt do commit final: vazio = padrão (preferências do usuário na
          memória; fallback Conventional Commits). */}
      <Dialog open={promptAberto} onOpenChange={setPromptAberto}>
        <DialogContent className="max-w-xl">
          <DialogTitle>{t("esteira.commitPromptTitulo")}</DialogTitle>
          <p className="text-[11px] text-muted-foreground">{t("esteira.commitPromptDica")}</p>
          <Textarea
            value={commitPrompt}
            onChange={(e) => setCommitPrompt(e.target.value)}
            placeholder={ESTEIRA_COMMIT_PROMPT_PADRAO}
            rows={12}
            className="text-xs"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">{t("esteira.commitPromptVazio")}</p>
            <Button size="sm" onClick={() => setPromptAberto(false)}>
              {t("common.close")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
  modeloPadrao,
  reasoningPadrao,
  mostrarPadrao,
  onEditar,
  onRemover,
}: {
  fase: FaseEscolhida
  indice: number
  modeloPadrao: { providerId: string; modelId: string } | null
  reasoningPadrao: ReasoningConfig | null
  /** Na criação: destaca as fases com modelo próprio (as demais seguem o padrão) */
  mostrarPadrao: boolean
  onEditar: () => void
  onRemover: () => void
}) {
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id: `fase-${indice}` })
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `alvo-${indice}` })
  const { t } = useTranslation()
  const proprio = !!fase.providerId && !!fase.modelId
  const rotuloModelo = useRotuloModelo(
    proprio ? fase.providerId : modeloPadrao?.providerId,
    proprio ? fase.modelId : modeloPadrao?.modelId,
    proprio ? (fase.reasoning ?? null) : reasoningPadrao,
  )

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
      {rotuloModelo && (
        <span
          className={cn(
            "max-w-44 shrink-0 truncate rounded px-1.5 py-0.5 text-[10px]",
            proprio && mostrarPadrao ? "bg-primary/10 text-primary" : "text-muted-foreground",
          )}
          title={proprio || !mostrarPadrao ? rotuloModelo : `${rotuloModelo} (${t("esteira.padrao")})`}
        >
          {rotuloModelo}
        </span>
      )}
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
