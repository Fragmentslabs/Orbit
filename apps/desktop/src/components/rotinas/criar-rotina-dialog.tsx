import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertCircleIcon, ArrowLeftIcon, FolderIcon, MessageSquareIcon, SparklesIcon } from "lucide-react"
import type { Agenda, RotinaModos, RotinaSugestao } from "@shared/rotinas"
import { parseHorario, ROTINA_MODOS_CHAT, ROTINA_PERMISSAO_PADRAO } from "@shared/rotinas"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { useWorkspace } from "@/lib/workspace-context"
import { BranchSelector } from "@/src/components/branch-selector"
import { FolderSelector } from "@/src/components/folder-selector"
import { ModelPicker } from "@/src/components/model-picker"
import { LOCALE_PROMPT_NAME, useLocaleStore } from "@/src/stores/locale-store"
import type { SelectedModel } from "@/src/stores/provider-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { sessionModelFor, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { useRotinasStore } from "@/src/stores/rotinas-store"
import { AgendaEditor, ModosEditor } from "./agenda-editor"

/**
 * Modal "Nova rotina", em duas etapas dentro do mesmo diálogo:
 *
 *   1. Descrever  — texto livre + modelo, e só isso
 *   2. Revisar    — o que o modelo propôs, tudo editável antes de confirmar
 *
 * A etapa 2 nunca é pulada: o agente SUGERE (título, prompt, agenda, modos) e
 * quem decide é o usuário — nada do gerador vai direto para o disco. A
 * transição entra pela direita e o topo ganha o botão de voltar, para a ida e
 * a volta entre as etapas ficarem óbvias.
 */
export function CriarRotinaDialog({
  aberto,
  onOpenChange,
  onCriada,
  modoPadrao = "code",
}: {
  aberto: boolean
  onOpenChange: (aberto: boolean) => void
  onCriada?: (rotinaId: string) => void
  /** Modo da página que abriu o modal: chat ou código. A rotina nasce nesse
   *  modo e não troca depois — pastas só existem no modo código. */
  modoPadrao: "chat" | "code"
}) {
  const { t } = useTranslation()
  const { folders: pastasDoWorkspace } = useWorkspace()
  const rotinas = useRotinasStore((s) => s.rotinas)
  const gerar = useRotinasStore((s) => s.gerar)
  const criar = useRotinasStore((s) => s.criar)
  // Modelo de visão configurado nas preferências: é o que a rotina guarda
  // quando o modo Visão está ligado (o main não lê o localStorage).
  const visionModel = useProviderStore((s) => s.visionModel)
  const visionDisponivel = !!visionModel

  const [descricao, setDescricao] = useState("")
  const [modelo, setModelo] = useState<SelectedModel | null>(null)
  // O modo vem da página que abriu o modal (a de chat cria rotinas de chat) —
  // no modo chat não há pastas de trabalho nem seletor delas.
  const [modo, setModo] = useState<"chat" | "code">(modoPadrao)
  // A pasta é escolhida NA ETAPA 1, junto com o modelo — a geração já usa essas
  // pastas como contexto do prompt. Semeada do workspace atual (o cenário mais
  // comum é rotina para o repositório que já está aberto), mas independente
  // dele dali em diante: trocar de pasta no chat por trás não pode mudar a
  // rotina que está sendo criada.
  const [pastas, setPastas] = useState<string[]>([])
  const [gerando, setGerando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [sugestao, setSugestao] = useState<RotinaSugestao | null>(null)

  // Campos da etapa 2 (partem da sugestão, mas seguem a edição do usuário)
  const [titulo, setTitulo] = useState("")
  const [prompt, setPrompt] = useState("")
  const [agenda, setAgenda] = useState<Agenda>({ horario: "09:00" })
  const [modos, setModos] = useState<RotinaModos>({ permissionMode: ROTINA_PERMISSAO_PADRAO })
  const [salvando, setSalvando] = useState(false)

  /**
   * Modelo padrão, nesta ordem: o da última rotina criada > o do último chat
   * (regra que já existe em sessionModelFor) > vazio. A rotina anterior vem
   * primeiro porque é o contexto mais próximo do que o usuário está fazendo
   * agora — quem monta a segunda rotina quer o mesmo modelo da primeira.
   */
  const padrao = useMemo<SelectedModel | null>(() => {
    const ultima = [...rotinas].sort((a, b) => b.criadoEm - a.criadoEm)[0]
    if (ultima) return ultima.modelo
    return sessionModelFor(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotinas.length])

  // Cada abertura recomeça do zero — reabrir o modal depois de criar uma
  // rotina não pode trazer de volta o rascunho da anterior.
  useEffect(() => {
    if (!aberto) return
    setDescricao("")
    setSugestao(null)
    setErro(null)
    setGerando(false)
    setModelo(padrao)
    setModo(modoPadrao)
    setPastas(modoPadrao === "chat" ? [] : pastasDoWorkspace)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto, padrao])

  const podeGerar = descricao.trim().length > 0 && !!modelo && !gerando

  const handleGerar = async () => {
    if (!podeGerar || !modelo) return
    setGerando(true)
    setErro(null)
    try {
      const idioma = LOCALE_PROMPT_NAME[useLocaleStore.getState().activeLocale]
      const resultado = await gerar(descricao.trim(), modelo, pastas, idioma, modo, visionDisponivel)
      if (!resultado.ok) {
        setErro(resultado.erro)
        return
      }
      setSugestao(resultado.sugestao)
      setTitulo(resultado.sugestao.titulo)
      setPrompt(resultado.sugestao.prompt)
      setAgenda(resultado.sugestao.agenda)
      setModos(resultado.sugestao.modos)
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err))
    } finally {
      setGerando(false)
    }
  }

  // Pasta é obrigatória só no modo código: o scheduler recusa disparar uma
  // rotina sem pasta de trabalho (electron/lib/rotinas/scheduler.ts) — sem
  // essa checagem aqui, a rotina seria criada e nunca rodaria, sem nenhum
  // aviso na hora. A rotina de chat roda sem pastas por definição.
  const podeCriar =
    !!modelo &&
    titulo.trim().length > 0 &&
    prompt.trim().length > 0 &&
    !!parseHorario(agenda.horario) &&
    (modo === "chat" || pastas.length > 0) &&
    !salvando

  const handleCriar = async () => {
    if (!podeCriar || !modelo) return
    setSalvando(true)
    try {
      const rotina = await criar({
        titulo: titulo.trim(),
        prompt: prompt.trim(),
        agenda,
        modelo,
        // Visão só funciona com o modelo de visão configurado — se o usuário
        // ligou o badge na revisão sem ter um, o modo sai desligado da criação
        // (o scheduler não teria o que enviar em `visionModel`).
        modos: modos.vision && !visionModel ? { ...modos, vision: undefined } : modos,
        mode: modo,
        pastas: modo === "chat" ? [] : pastas,
        visionModel: modos.vision ? (visionModel ?? undefined) : undefined,
        ativa: true,
      })
      // Recentes são globais e compartilhados com os chats. O modelo entra na
      // lista aqui — criar a rotina é o momento em que ele passa a ser usado
      // de verdade (mesmo critério do modal da esteira).
      useSessionModelPrefs.getState().markUsed(modelo.providerId, modelo.modelId)
      onOpenChange(false)
      onCriada?.(rotina.id)
    } finally {
      setSalvando(false)
    }
  }

  const naRevisao = !!sugestao

  return (
    <Dialog open={aberto} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl overflow-hidden">
        <div className="flex items-center gap-2">
          {naRevisao && (
            <Button variant="ghost" size="icon-sm" onClick={() => setSugestao(null)} aria-label={t("rotinas.revisar.voltar")}>
              <ArrowLeftIcon className="size-3.5" />
            </Button>
          )}
          <div className="min-w-0">
            <DialogTitle>{naRevisao ? t("rotinas.revisar.titulo") : t("rotinas.criar.titulo")}</DialogTitle>
            <p className="truncate text-[11px] text-muted-foreground">
              {naRevisao ? t("rotinas.revisar.subtitulo") : t("rotinas.criar.descreverDica")}
            </p>
          </div>
        </div>

        {naRevisao ? (
          <div
            // key força a animação a rodar de novo a cada ida para a revisão
            key="revisar"
            className="animate-in slide-in-from-right-8 fade-in-0 duration-200"
          >
            <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
              <Campo rotulo={t("rotinas.revisar.campoTitulo")}>
                <Input value={titulo} onChange={(e) => setTitulo(e.target.value)} className="h-8 text-sm" />
              </Campo>

              <Campo rotulo={t("rotinas.revisar.campoPrompt")} dica={t("rotinas.revisar.campoPromptDica")}>
                <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="max-h-56 min-h-28" />
              </Campo>

              <Campo rotulo={t("rotinas.revisar.agenda")}>
                <AgendaEditor agenda={agenda} onChange={setAgenda} />
              </Campo>

              <Campo rotulo={t("rotinas.revisar.modos")} dica={t("rotinas.revisar.modosDica")}>
                <ModosEditor modos={modos} onChange={setModos} disponiveis={modo === "chat" ? ROTINA_MODOS_CHAT : undefined} />
              </Campo>

              <Campo rotulo={t("rotinas.criar.modelo")}>
                <ModelPicker value={modelo} onValueChange={setModelo} />
              </Campo>

              {modo === "code" && (
                <Campo rotulo={t("rotinas.revisar.pastas")} dica={t("rotinas.revisar.pastasDica")}>
                  {pastas.length === 0 ? (
                    <p className="text-[11px] text-destructive">{t("rotinas.revisar.semPastas")}</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {pastas.map((pasta) => (
                        <li key={pasta} className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                          <FolderIcon className="size-3 shrink-0" />
                          <span className="truncate">{pasta}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Campo>
              )}
            </div>

            <div className="mt-3 flex justify-end gap-2 border-t pt-3">
              <Button variant="ghost" size="sm" onClick={() => setSugestao(null)}>
                {t("rotinas.revisar.voltar")}
              </Button>
              <Button size="sm" disabled={!podeCriar} onClick={() => void handleCriar()}>
                {t("rotinas.revisar.criar")}
              </Button>
            </div>
          </div>
        ) : (
          <div key="descrever" className="animate-in slide-in-from-left-8 fade-in-0 duration-200">
            <Textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder={t(modo === "chat" ? "rotinas.criar.placeholderChat" : "rotinas.criar.placeholder")}
              className="max-h-64 min-h-36"
              disabled={gerando}
            />

            {erro && (
              <p className="mt-2 flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
                <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{erro}</span>
              </p>
            )}

            {gerando && (
              <div className="mt-2 space-y-2 rounded-lg border bg-card p-3">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              {modo === "chat" ? (
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <MessageSquareIcon className="size-3.5" />
                  {t("rotinas.criar.modoChatDica")}
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <FolderSelector folders={pastas} onFoldersChange={setPastas} />
                  {pastas[0] && <BranchSelector repoPath={pastas[0]} />}
                </div>
              )}
              <ModelPicker value={modelo} onValueChange={setModelo} />
            </div>
            {!modelo && <p className="mt-1.5 text-[11px] text-muted-foreground">{t("rotinas.criar.semModelo")}</p>}

            <div className="mt-2 flex justify-end">
              <Button size="sm" disabled={!podeGerar} onClick={() => void handleGerar()}>
                <SparklesIcon className="size-3.5" />
                {gerando ? t("rotinas.criar.gerando") : t("rotinas.criar.gerar")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
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
