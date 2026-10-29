import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { CalendarClock, Check, MessageSquareIcon, TerminalIcon } from "lucide-react"
import type { Agenda } from "@shared/rotinas"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { MessagePart, ToolPart } from "@shared/chat"
import { Shimmer } from "@/src/components/ai/shimmer"
import { descreverAgenda } from "@/src/components/rotinas/agenda"
import { useRotinasPropostasStore } from "@/src/stores/rotinas-propostas-store"
import { useRotinasStore } from "@/src/stores/rotinas-store"

/**
 * Card da proposta de rotina (tool rotinas_manage, ação "criar"): a rotina
 * fica em staging até a pessoa clicar "Criar rotina". Mesmo padrão do
 * SkillProposalCard — pendente → botões; criada → check; dispensada → nota.
 *
 * Só as partes de "criar" viram card; as outras ações da tool caem no grupo
 * de ações genérico (ver isRotinaProposal nos message components).
 */

/** É a parte que vira card: rotinas_manage com ação "criar". */
export function isRotinaProposal(part: MessagePart): boolean {
  if (part.type !== "tool" || part.tool !== "rotinas_manage") return false
  return part.input?.action === "criar"
}

/** O output da tool confirma o id ("Proposta de rotina criada (id: ...)"). */
function idDaProposta(part: ToolPart): string | null {
  return part.output?.match(/id:\s*([a-zA-Z0-9_-]+)/)?.[1] ?? null
}

export function RotinaProposalCard({ part }: { part: ToolPart }) {
  const { t } = useTranslation()
  const carregar = useRotinasPropostasStore((s) => s.carregar)
  const pendentes = useRotinasPropostasStore((s) => s.pendentes)
  const descartadas = useRotinasPropostasStore((s) => s.descartadas)
  const aprovar = useRotinasPropostasStore((s) => s.aprovar)
  const descartar = useRotinasPropostasStore((s) => s.descartar)
  const rotinas = useRotinasStore((s) => s.rotinas)

  useEffect(() => {
    void carregar()
  }, [carregar])

  if (part.state === "running") {
    return <Shimmer className="text-sm">{t("rotinaProposal.building")}</Shimmer>
  }
  if (part.state === "error") return null

  const id = idDaProposta(part)
  if (!id) return null

  const proposta = pendentes.find((p) => p.id === id)
  const criada = rotinas.some((r) => r.id === id)
  const wasDiscarded = descartadas.includes(id)
  // Botões enquanto há proposta pendente; "criada" e "descartada" são estados
  // derivados do disco/do store, como no card de skill.
  const actionable = !criada && !wasDiscarded && proposta !== undefined

  const titulo = (part.input?.titulo as string | undefined) ?? proposta?.titulo ?? "Rotina"
  const mode = (part.input?.mode as "chat" | "code" | undefined) ?? proposta?.mode ?? "code"
  const agenda = proposta?.agenda ?? (part.input?.agenda as Agenda | undefined)
  const agendaTexto = agenda ? descreverAgenda(agenda, t) : null

  return (
    <div className="not-prose my-2 flex w-full flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-start gap-2">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{titulo}</span>
            <Badge
              variant="outline"
              className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] text-muted-foreground"
            >
              {mode === "chat" ? (
                <MessageSquareIcon className="size-3" />
              ) : (
                <TerminalIcon className="size-3" />
              )}
              {mode === "chat" ? t("rotinas.modo.chat") : t("rotinas.modo.code")}
            </Badge>
          </div>
          {agendaTexto && <p className="mt-0.5 text-xs text-muted-foreground">{agendaTexto}</p>}
        </div>
      </div>
      {criada ? (
        <p className="flex items-center gap-1.5 text-xs text-emerald-500">
          <Check className="size-3.5" /> {t("rotinaProposal.created")}
        </p>
      ) : actionable ? (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => void descartar(id)}>
            {t("rotinaProposal.discard")}
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => void aprovar(id)}>
            <CalendarClock className="size-3.5" />
            {t("rotinaProposal.create")}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("rotinaProposal.discarded")}</p>
      )}
    </div>
  )
}
