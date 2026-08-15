import { useTranslation } from "react-i18next"
import { AlignLeft, Bot, BrainCircuit, Eye, FileText, Globe, Network, RefreshCw, Search } from "lucide-react"
import type { PermissionMode } from "@shared/chat"
import type { Agenda, RotinaModos } from "@shared/rotinas"
import { parseHorario, ROTINA_MODOS, ROTINA_PERMISSAO_PADRAO, ROTINA_PERMISSOES } from "@shared/rotinas"
import { cn } from "@/lib/utils"
import { Switch } from "@/components/ui/switch"
import { descreverAgenda, diasCurtos, modoDaAgenda, type ModoAgenda } from "./agenda"

/**
 * Edição da agenda e dos modos — compartilhada pela criação e pela edição de
 * uma rotina existente. A agenda é estruturada, então a UI é de presets +
 * ajuste fino, no espírito do ScheduleMessageDialog: ninguém deveria precisar
 * escrever cron para dizer "todo dia às 9".
 */

const UTEIS = [1, 2, 3, 4, 5]
const FIM_DE_SEMANA = [0, 6]

export function AgendaEditor({ agenda, onChange }: { agenda: Agenda; onChange: (agenda: Agenda) => void }) {
  const { t } = useTranslation()
  const modo = modoDaAgenda(agenda)
  const nomes = diasCurtos(t)
  const horarioValido = !!parseHorario(agenda.horario)

  const trocarModo = (proximo: ModoAgenda) => {
    if (proximo === "diario") onChange({ horario: agenda.horario })
    else if (proximo === "semanal") onChange({ horario: agenda.horario, dias: agenda.dias?.length ? agenda.dias : UTEIS })
    else onChange({ horario: agenda.horario, intervaloDias: agenda.intervaloDias ?? 2 })
  }

  const alternarDia = (dia: number) => {
    const atuais = new Set(agenda.dias ?? [])
    if (atuais.has(dia)) atuais.delete(dia)
    else atuais.add(dia)
    // Nunca deixa a lista vazia: sem nenhum dia marcado a rotina não teria
    // quando rodar, e a tela mostraria uma agenda que nunca dispara.
    const dias = [...atuais].sort((a, b) => a - b)
    onChange({ horario: agenda.horario, dias: dias.length ? dias : [dia] })
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {(["diario", "semanal", "intervalo"] as ModoAgenda[]).map((op) => (
          <button
            key={op}
            type="button"
            onClick={() => trocarModo(op)}
            className={cn(
              "rounded-md border px-2 py-1 text-[10px] font-medium transition-colors",
              modo === op
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted",
            )}
          >
            {t(`rotinas.agenda.modo.${op}`)}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{t("rotinas.agenda.horario")}</span>
          <input
            type="text"
            value={agenda.horario}
            placeholder="HH:MM"
            onChange={(e) => onChange({ ...agenda, horario: e.target.value })}
            className={cn(
              "w-20 rounded-md border bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
              horarioValido ? "border-input" : "border-destructive",
            )}
          />
        </span>
      </div>

      {modo === "semanal" && (
        <div className="flex flex-wrap items-center gap-1">
          {nomes.map((nome, dia) => {
            const ativo = agenda.dias?.includes(dia) ?? false
            return (
              <button
                key={dia}
                type="button"
                onClick={() => alternarDia(dia)}
                className={cn(
                  "size-7 rounded-md border text-[11px] font-medium transition-colors",
                  ativo
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted",
                )}
              >
                {nome}
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => onChange({ horario: agenda.horario, dias: UTEIS })}
            className="ml-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {t("rotinas.agenda.uteis")}
          </button>
          <button
            type="button"
            onClick={() => onChange({ horario: agenda.horario, dias: FIM_DE_SEMANA })}
            className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {t("rotinas.agenda.fimDeSemana")}
          </button>
        </div>
      )}

      {modo === "intervalo" && (
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {t("rotinas.agenda.aCada")}
          <input
            type="number"
            min={2}
            max={365}
            value={agenda.intervaloDias ?? 2}
            onChange={(e) =>
              onChange({
                horario: agenda.horario,
                intervaloDias: Math.max(2, Math.min(365, Number(e.target.value) || 2)),
              })
            }
            className="w-16 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          {t("rotinas.agenda.dias")}
        </label>
      )}

      <p className="text-[11px] text-muted-foreground">{descreverAgenda(agenda, t)}</p>
    </div>
  )
}

// ─── Modos ───────────────────────────────────────────────────────────────────

/** Ícone de cada modo — os mesmos da seção "modos ativos" das preferências. */
const MODO_ICONE: Record<(typeof ROTINA_MODOS)[number], typeof Bot> = {
  brain: BrainCircuit,
  loop: RefreshCw,
  subagents: Bot,
  orchestrate: Network,
  browser: Globe,
  plan: FileText,
  simple: AlignLeft,
  search: Search,
  vision: Eye,
}

/** Chaves de modo editáveis — o subconjunto depende do modo da rotina. */
type ChaveDeModo = (typeof ROTINA_MODOS)[number]

/**
 * Modos como badges clicáveis, no mesmo padrão de "modos ativos por padrão"
 * das preferências: ligado fica dourado (primary), desligado fica ghost. O
 * agente SUGERE na criação — quem confirma é o usuário, num clique.
 */
export function ModosEditor({
  modos,
  onChange,
  disponiveis = ROTINA_MODOS,
}: {
  modos: RotinaModos
  onChange: (modos: RotinaModos) => void
  /** Modos exibidos — rotina de chat recebe ROTINA_MODOS_CHAT. */
  disponiveis?: ChaveDeModo[]
}) {
  const { t } = useTranslation()
  const permissao = modos.permissionMode ?? ROTINA_PERMISSAO_PADRAO

  const alternar = (chave: ChaveDeModo) => {
    const ligado = modos[chave] !== true
    const proximo: RotinaModos = { ...modos, [chave]: ligado || undefined }
    // Orquestração implica loop + subagentes e é incompatível com plano —
    // mesma regra do handler chat:send, aplicada aqui para a tela não mostrar
    // uma combinação que o backend vai desfazer sozinho.
    if (chave === "orchestrate" && ligado) {
      proximo.loop = true
      proximo.subagents = true
      proximo.plan = undefined
    }
    if (chave === "plan" && ligado) proximo.orchestrate = undefined
    onChange(proximo)
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {disponiveis.map((chave) => {
          const Icon = MODO_ICONE[chave]
          const ativo = modos[chave] === true
          return (
            <button
              key={chave}
              type="button"
              onClick={() => alternar(chave)}
              title={t(`rotinas.modos.${chave}.descricao`)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors",
                ativo
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted",
              )}
            >
              <Icon className="size-3.5" />
              {t(`rotinas.modos.${chave}.nome`)}
            </button>
          )
        })}
      </div>

      <div className="space-y-1">
        <p className="text-[11px] text-muted-foreground">{t("permissions.title")}</p>
        <div className="flex flex-wrap gap-1.5">
          {ROTINA_PERMISSOES.map((op) => (
            <button
              key={op}
              type="button"
              onClick={() => onChange({ ...modos, permissionMode: op })}
              title={t(`permissions.${op}Description`)}
              className={cn(
                "rounded-md border px-2 py-1 text-[10px] font-medium transition-colors",
                permissao === op
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted",
              )}
            >
              {t(`permissions.${op}`)}
            </button>
          ))}
        </div>
        {permissao === "ask" && (
          <p className="text-[11px] text-muted-foreground">{t("rotinas.modos.permissaoAviso")}</p>
        )}
      </div>
    </div>
  )
}

/** Badges compactas (só leitura) dos modos ligados — cartão e detalhe. */
export function ModosBadges({
  modos,
  permissao,
  disponiveis = ROTINA_MODOS,
}: {
  modos: RotinaModos
  permissao?: boolean
  /** Modos considerados — rotina de chat não exibe loop/orquestra mesmo se o
   *  rotinas.json editado à mão tiver o campo (o scheduler ignora de todo). */
  disponiveis?: ChaveDeModo[]
}) {
  const { t } = useTranslation()
  const ativos = disponiveis.filter((chave) => modos[chave] === true)
  const modoPermissao: PermissionMode = modos.permissionMode ?? ROTINA_PERMISSAO_PADRAO
  if (ativos.length === 0 && !permissao) return null
  return (
    <span className="flex flex-wrap items-center gap-1">
      {ativos.map((chave) => {
        const Icon = MODO_ICONE[chave]
        return (
          <span
            key={chave}
            title={t(`rotinas.modos.${chave}.descricao`)}
            className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
          >
            <Icon className="size-3" />
            {t(`rotinas.modos.${chave}.nome`)}
          </span>
        )
      })}
      {permissao && (
        <span
          title={t(`permissions.${modoPermissao}Description`)}
          className="inline-flex items-center rounded-md border border-transparent bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {t(`permissions.${modoPermissao}`)}
        </span>
      )}
    </span>
  )
}

/** Switch de ativar/desativar reusado pelo cartão e pelo header do detalhe. */
export function AtivaSwitch({ ativa, onChange }: { ativa: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <Switch
      checked={ativa}
      onCheckedChange={onChange}
      aria-label={ativa ? t("rotinas.lista.ativa") : t("rotinas.lista.pausada")}
      title={ativa ? t("rotinas.lista.ativa") : t("rotinas.lista.pausada")}
    />
  )
}
