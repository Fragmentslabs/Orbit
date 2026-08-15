import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FolderIcon,
  Loader2,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react"
import type { SessionInfo } from "@shared/chat"
import type { Agenda, Rotina, RotinaModos, RotinaRun } from "@shared/rotinas"
import { parseHorario, proximaExecucaoDaRotina, ROTINA_MODOS_CHAT } from "@shared/rotinas"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useWorkspace } from "@/lib/workspace-context"
import { cn } from "@/lib/utils"
import { formatCost, formatDateTimeShort, formatDuration, formatTokens } from "@/src/lib/format"
import { ModelPicker } from "@/src/components/model-picker"
import { useProviderStore, type SelectedModel } from "@/src/stores/provider-store"
import { useSessionStore } from "@/src/stores/session-store"
import { useRotinasStore } from "@/src/stores/rotinas-store"
import { descreverAgenda } from "./agenda"
import { AgendaEditor, AtivaSwitch, ModosBadges, ModosEditor } from "./agenda-editor"

/**
 * Listagem das rotinas e a sub-página de detalhe com o histórico de sessões.
 *
 * A lista de sessões é DERIVADA das sessões de chat (`routineId`), com as
 * métricas de `runs` casadas por sessionId. Uma fonte de verdade só: excluir a
 * sessão na sidebar tira a linha daqui sem deixar registro "excluído".
 */

// ─── Lista ───────────────────────────────────────────────────────────────────

export function ListaDeRotinas({ modo, onCriarNova }: { modo: "chat" | "code"; onCriarNova: () => void }) {
  const { t } = useTranslation()
  const rotinas = useRotinasStore((s) => s.rotinas)
  const setAberta = useRotinasStore((s) => s.setAberta)

  // A página é do modo que a abriu: a de chat lista só rotinas de chat e a de
  // código só as de código (a sidebar separa as sessões do mesmo jeito).
  const ordenadas = useMemo(
    () => rotinas.filter((r) => r.mode === modo).sort((a, b) => b.criadoEm - a.criadoEm),
    [rotinas, modo],
  )

  if (ordenadas.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <CalendarClockIcon className="size-10 text-muted-foreground/50" />
        <div>
          <p className="text-sm font-medium">{t("rotinas.lista.vazioTitulo")}</p>
          <p className="mx-auto max-w-sm text-xs text-muted-foreground">
            {t(modo === "chat" ? "rotinas.lista.vazioSubtituloChat" : "rotinas.lista.vazioSubtitulo")}
          </p>
        </div>
        <Button size="lg" onClick={onCriarNova}>
          <CalendarClockIcon className="size-4" />
          {t("rotinas.lista.criarPrimeira")}
        </Button>
      </div>
    )
  }

  return (
    <div className="grid min-h-0 flex-1 auto-rows-min gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
      {ordenadas.map((rotina) => (
        <CartaoDaRotina key={rotina.id} rotina={rotina} onAbrir={() => setAberta(rotina.id)} />
      ))}
    </div>
  )
}

function CartaoDaRotina({ rotina, onAbrir }: { rotina: Rotina; onAbrir: () => void }) {
  const { t, i18n } = useTranslation()
  const atualizar = useRotinasStore((s) => s.atualizar)
  const rodando = useRotinasStore((s) => s.runs.some((r) => r.rotinaId === rotina.id && r.status === "rodando"))
  const nomeModelo = useProviderStore(
    (s) => s.catalog[rotina.modelo.providerId]?.models[rotina.modelo.modelId]?.name ?? rotina.modelo.modelId,
  )

  const proxima = proximaExecucaoDaRotina(rotina)

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:border-ring">
      <div className="flex items-center gap-2">
        <CalendarClockIcon className="size-4 shrink-0 text-muted-foreground" />
        <button type="button" onClick={onAbrir} className="min-w-0 flex-1 truncate text-left text-sm font-medium">
          {rotina.titulo}
        </button>
        {rodando && (
          <span title={t("rotinas.runs.rodando")}>
            <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
          </span>
        )}
        <AtivaSwitch ativa={rotina.ativa} onChange={(v) => void atualizar(rotina.id, { ativa: v })} />
      </div>

      <button type="button" onClick={onAbrir} className="min-w-0 space-y-1.5 text-left">
        <p className="truncate text-[11px] text-muted-foreground">{descreverAgenda(rotina.agenda, t)}</p>
        <p className="line-clamp-2 text-[11px] text-muted-foreground/80">{rotina.prompt}</p>
        <ModosBadges modos={rotina.modos} permissao disponiveis={rotina.mode === "chat" ? ROTINA_MODOS_CHAT : undefined} />
        <p className="truncate text-[11px] text-muted-foreground">{nomeModelo}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {proxima
            ? t("rotinas.lista.proxima", { quando: formatDateTimeShort(proxima, i18n.language) })
            : t("rotinas.lista.pausada")}
        </p>
      </button>
    </div>
  )
}

// ─── Edição ──────────────────────────────────────────────────────────────────

function EditarRotinaDialog({
  rotina,
  aberto,
  onOpenChange,
}: {
  rotina: Rotina
  aberto: boolean
  onOpenChange: (aberto: boolean) => void
}) {
  const { t } = useTranslation()
  const atualizar = useRotinasStore((s) => s.atualizar)
  const [titulo, setTitulo] = useState(rotina.titulo)
  const [prompt, setPrompt] = useState(rotina.prompt)
  const [agenda, setAgenda] = useState<Agenda>(rotina.agenda)
  const [modos, setModos] = useState<RotinaModos>(rotina.modos)
  const [modelo, setModelo] = useState<SelectedModel | null>(rotina.modelo)

  // Reabrir o modal recomeça da rotina persistida (o scheduler pode ter mexido
  // nela enquanto estava fechado).
  const chave = `${rotina.id}:${aberto}`
  const [ultimaChave, setUltimaChave] = useState(chave)
  if (chave !== ultimaChave) {
    setUltimaChave(chave)
    if (aberto) {
      setTitulo(rotina.titulo)
      setPrompt(rotina.prompt)
      setAgenda(rotina.agenda)
      setModos(rotina.modos)
      setModelo(rotina.modelo)
    }
  }

  const podeSalvar =
    titulo.trim().length > 0 && prompt.trim().length > 0 && !!parseHorario(agenda.horario) && !!modelo

  const salvar = async () => {
    if (!podeSalvar || !modelo) return
    await atualizar(rotina.id, {
      titulo: titulo.trim(),
      prompt: prompt.trim(),
      agenda,
      modos,
      modelo,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={aberto} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t("rotinas.lista.editar")}</DialogTitle>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("rotinas.revisar.campoTitulo")}</p>
            <Input value={titulo} onChange={(e) => setTitulo(e.target.value)} className="h-8 text-sm" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("rotinas.revisar.campoPrompt")}</p>
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="max-h-56 min-h-28" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("rotinas.revisar.agenda")}</p>
            <AgendaEditor agenda={agenda} onChange={setAgenda} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("rotinas.revisar.modos")}</p>
            <ModosEditor
              modos={modos}
              onChange={setModos}
              disponiveis={rotina.mode === "chat" ? ROTINA_MODOS_CHAT : undefined}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("rotinas.criar.modelo")}</p>
            <ModelPicker value={modelo} onValueChange={setModelo} />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!podeSalvar} onClick={() => void salvar()}>
            {t("rotinas.lista.salvar")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Sub-página de detalhe ───────────────────────────────────────────────────

/**
 * Detalhe da rotina como PÁGINA: substitui a tela de rotinas inteira, com
 * header próprio (voltar, título, agenda, switch, executar, ellipsis). O
 * header da listagem some — quem está aqui está dentro de UMA rotina.
 */
export function DetalheDaRotina({ rotina, onVoltar }: { rotina: Rotina; onVoltar: () => void }) {
  const { t, i18n } = useTranslation()
  const atualizar = useRotinasStore((s) => s.atualizar)
  const executarAgora = useRotinasStore((s) => s.executarAgora)
  const remover = useRotinasStore((s) => s.remover)
  const runs = useRotinasStore((s) => s.runs)
  const rodando = runs.some((r) => r.rotinaId === rotina.id && r.status === "rodando")
  const sessions = useSessionStore((s) => s.sessions)
  const nomeModelo = useProviderStore(
    (s) => s.catalog[rotina.modelo.providerId]?.models[rotina.modelo.modelId]?.name ?? rotina.modelo.modelId,
  )
  const [editando, setEditando] = useState(false)
  const [confirmar, setConfirmar] = useState(false)

  // Lista DERIVADA das sessões: uma sessão excluída pela sidebar some daqui
  // sozinha, sem estado "excluído" pendurado no registro da rotina.
  const execucoes = useMemo(() => {
    const metricas = new Map(runs.filter((r) => r.rotinaId === rotina.id).map((r) => [r.sessionId, r]))
    return sessions
      .filter((s) => s.routineId === rotina.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((session) => ({ session, run: metricas.get(session.id) }))
  }, [sessions, runs, rotina.id])

  const proxima = proximaExecucaoDaRotina(rotina)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={onVoltar} aria-label={t("rotinas.revisar.voltar")}>
          <ArrowLeftIcon className="size-3.5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 truncate text-base font-semibold text-foreground">
            {rotina.titulo}
            {rodando && <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {descreverAgenda(rotina.agenda, t)}
            {" · "}
            {proxima
              ? t("rotinas.lista.proxima", { quando: formatDateTimeShort(proxima, i18n.language) })
              : t("rotinas.lista.pausada")}
          </p>
        </div>
        <AtivaSwitch ativa={rotina.ativa} onChange={(v) => void atualizar(rotina.id, { ativa: v })} />
        <Button size="sm" variant="outline" disabled={rodando} onClick={() => void executarAgora(rotina.id)}>
          <PlayIcon className="size-3.5" />
          {t("rotinas.lista.executarAgora")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem onClick={() => setEditando(true)}>
              <PencilIcon className="size-3.5" />
              {t("rotinas.lista.editar")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setConfirmar(true)}>
              <Trash2Icon className="size-3.5" />
              {t("rotinas.lista.excluir")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="shrink-0 space-y-1.5 rounded-lg border bg-card p-3">
        <p className="whitespace-pre-wrap text-[11px] text-muted-foreground">{rotina.prompt}</p>
        <span className="flex flex-wrap items-center gap-1">
          <ModosBadges modos={rotina.modos} permissao disponiveis={rotina.mode === "chat" ? ROTINA_MODOS_CHAT : undefined} />
          {rotina.mode === "chat" && (
            <span className="inline-flex items-center rounded-md border border-transparent bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t("rotinas.modo.chat")}
            </span>
          )}
        </span>
        <p className="truncate text-[11px] text-muted-foreground">{nomeModelo}</p>
        {rotina.pastas.length > 0 && (
          <p className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
            <FolderIcon className="size-3 shrink-0" />
            <span className="truncate">{rotina.pastas.join(", ")}</span>
          </p>
        )}
      </div>

      <p className="shrink-0 text-xs font-medium">{t("rotinas.runs.titulo")}</p>

      {execucoes.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("rotinas.runs.vazio")}</p>
      ) : (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
          {execucoes.map(({ session, run }) => (
            <LinhaDoRun key={session.id} session={session} run={run} />
          ))}
        </div>
      )}

      <EditarRotinaDialog rotina={rotina} aberto={editando} onOpenChange={setEditando} />
      <ConfirmDialog
        open={confirmar}
        onOpenChange={setConfirmar}
        title={t("rotinas.lista.excluirTitulo")}
        description={t("rotinas.lista.excluirDescricao", { titulo: rotina.titulo })}
        confirmLabel={t("rotinas.lista.excluir")}
        destructive
        onConfirm={() => void remover(rotina.id)}
      />
    </div>
  )
}

function LinhaDoRun({ session, run }: { session: SessionInfo; run?: RotinaRun }) {
  const { t, i18n } = useTranslation()
  const { mode, setMode, setView, setFolders } = useWorkspace()
  // O status ao vivo vem do store de sessões — é a mesma fonte do spinner da
  // sidebar. `run` só tem a foto final (tokens, custo, duração).
  const statusSessao = useSessionStore((s) => s.status[session.id])
  const rodando = statusSessao === "submitted" || statusSessao === "streaming" || run?.status === "rodando"
  const status = rodando ? "rodando" : (run?.status ?? "ok")

  const abrirChat = () => {
    // Mesmo caminho do SessionRow da sidebar: ativa a sessão no modo dela (a
    // rotina de chat abre no chat; a de código abre no código) e sai da
    // página de rotinas para a conversa.
    const targetMode = session.mode
    if (targetMode !== mode) setMode(targetMode)
    if (session.directory) setFolders([session.directory, ...(session.extraDirectories ?? [])])
    void useSessionStore.getState().selectSession(targetMode, session.id)
    setView("chat")
  }

  const duracao =
    run?.concluidoEm && run.iniciadoEm ? formatDuration(run.concluidoEm - run.iniciadoEm) : undefined

  return (
    <button
      type="button"
      onClick={abrirChat}
      className="flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:border-ring"
    >
      {status === "rodando" ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
      ) : status === "erro" ? (
        <AlertCircleIcon className="size-3.5 shrink-0 text-destructive" />
      ) : (
        <CheckCircle2Icon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs">{formatDateTimeShort(run?.iniciadoEm ?? session.createdAt, i18n.language)}</p>
        <p className={cn("truncate text-[11px]", status === "erro" ? "text-destructive" : "text-muted-foreground")}>
          {status === "rodando"
            ? t("rotinas.runs.rodando")
            : status === "erro"
              ? run?.erro || t("rotinas.runs.erro")
              : [
                  duracao,
                  run && run.tokens > 0 ? t("rotinas.runs.tokens", { valor: formatTokens(run.tokens) }) : null,
                  run && run.custo > 0 ? formatCost(run.custo) : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || t("rotinas.runs.ok")}
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        {t("rotinas.runs.abrirChat")}
        <ExternalLinkIcon className="size-3" />
      </span>
    </button>
  )
}
