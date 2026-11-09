import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon, ChevronUpIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { userProfileId } from "@shared/agents"
import type { TeamMember } from "@shared/routines"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { isTeam, newMember, waitsFor, withoutMember, type AgentsDraft } from "@/src/lib/agents-draft"
import { estimateTeamTokens } from "@/src/lib/team-estimate"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { useAgents } from "@/src/stores/agents-store"
import { AgentMenu } from "./agent-menu"

const NUMBER_INPUT = "h-8 w-20 text-sm"

/**
 * The agents of a routine. With one, it is just that: which agent does the job. "Add agent" turns
 * it into a team, drawn like the design: a row per agent (icon, name, what it does, and whether it
 * starts right away or after others) that opens to edit; the limits appear below (how many work at
 * once, how many tokens one execution may spend).
 */
export function AgentsEditor({ value, onChange, routineId }: {
  value: AgentsDraft
  onChange: (next: AgentsDraft) => void
  /** The routine being edited: its past runs make the token estimate honest. */
  routineId?: string
}) {
  const { t } = useTranslation()
  const agents = useAgents()
  const { members } = value
  const team = isTeam(value)
  const allRuns = useRoutinesStore((s) => s.runs)
  const estimate = team
    ? estimateTeamTokens(members.length, { review: value.review, pastRuns: routineId ? allRuns.filter((r) => r.routineId === routineId) : [] })
    : null
  const [openId, setOpenId] = useState<string | null>(null)
  const agentName = (m: TeamMember) => agents.find((a) => userProfileId(a.id) === m.agent)?.name

  const patch = (id: string, change: Partial<TeamMember>) =>
    onChange({ ...value, members: members.map((m) => (m.id === id ? { ...m, ...change } : m)) })
  const add = () => {
    // The single agent becomes the first member of the team, named after its agent.
    const first = members.map((m) => (m.name ? m : { ...m, name: agentName(m) ?? t("routines.agents.first") }))
    const created = newMember()
    onChange({ ...value, members: [...first, created] })
    setOpenId(created.id)
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-xs font-medium">
          {t("routines.agents.title")}
          {team && <span className="ml-1.5 font-normal text-muted-foreground">{t("routines.agents.count", { count: members.length })}</span>}
        </p>
      </div>

      {!team ? (
        <div className="flex items-center gap-2 rounded-lg border bg-card p-2.5">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-[11px] text-muted-foreground">{t("routines.agents.solo")}</p>
            <AgentMenu value={members[0]?.agent} onChange={(agent) => members[0] && patch(members[0].id, { agent })} />
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          {members.map((member, index) => {
            const open = openId === member.id
            const waits = waitsFor(member, members, t("routines.agents.unnamed"))
            return (
              <div key={member.id} className={cn(index > 0 && "border-t")}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <AgentMenu compact value={member.agent} onChange={(agent) => patch(member.id, { agent })} />
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : member.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={open}
                  >
                    <span className="shrink-0 text-xs font-medium">{member.name.trim() || t("routines.agents.unnamed")}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{member.task.trim()}</span>
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                      {waits.length === 0 ? t("routines.agents.stageFirst") : t("routines.agents.stageAfter", { names: waits.join(", ") })}
                    </span>
                    {open ? <ChevronUpIcon className="size-3.5 shrink-0" /> : <ChevronDownIcon className="size-3.5 shrink-0" />}
                  </button>
                </div>
                {open && (
                  <div className="space-y-2 border-t bg-muted/20 px-3 py-2.5">
                    <Input
                      value={member.name}
                      onChange={(e) => patch(member.id, { name: e.target.value })}
                      placeholder={t("routines.agents.namePlaceholder")}
                      className="h-8 text-sm"
                    />
                    <Input
                      value={member.task}
                      onChange={(e) => patch(member.id, { task: e.target.value })}
                      placeholder={t("routines.agents.taskPlaceholder")}
                      className="h-8 text-sm"
                    />
                    <div className="flex items-center gap-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger className="h-8 rounded-md border bg-background px-2.5 text-xs hover:bg-accent">
                          {waits.length === 0 ? t("routines.agents.waitsNone") : t("routines.agents.waitsFor", { names: waits.join(", ") })}
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-52">
                          {members
                            .filter((other) => other.id !== member.id)
                            .map((other) => (
                              <DropdownMenuCheckboxItem
                                key={other.id}
                                checked={member.dependsOn?.includes(other.id) ?? false}
                                onCheckedChange={(on) => {
                                  const current = member.dependsOn ?? []
                                  patch(member.id, { dependsOn: on ? [...current, other.id] : current.filter((d) => d !== other.id) })
                                }}
                              >
                                {other.name.trim() || t("routines.agents.unnamed")}
                              </DropdownMenuCheckboxItem>
                            ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <span className="flex-1" />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 text-xs text-muted-foreground"
                        onClick={() => onChange(withoutMember(value, member.id))}
                      >
                        <Trash2Icon className="size-3.5" />
                        {t("routines.agents.remove")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <button
        type="button"
        onClick={add}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-2 text-xs text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
      >
        <PlusIcon className="size-3.5" />
        {t("routines.agents.add")}
      </button>

      {team && (
        <>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">{t("routines.agents.parallel")}</span>
              <Input
                type="number"
                min={1}
                max={8}
                value={value.maxParallel ?? ""}
                placeholder="4"
                onChange={(e) => onChange({ ...value, maxParallel: e.target.value ? Number(e.target.value) : undefined })}
                className={NUMBER_INPUT}
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">{t("routines.agents.budget")}</span>
              <Input
                type="number"
                min={1}
                value={value.tokenBudget ? Math.round(value.tokenBudget / 1000) : ""}
                placeholder="∞"
                onChange={(e) => onChange({ ...value, tokenBudget: e.target.value ? Number(e.target.value) * 1000 : undefined })}
                className={NUMBER_INPUT}
              />
              <span className="text-muted-foreground">{t("routines.agents.budgetUnit")}</span>
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={value.review === true}
              onChange={(e) => onChange({ ...value, review: e.target.checked || undefined })}
              className="size-3.5"
            />
            <span>{t("routines.agents.review")}</span>
          </label>
          <p className="text-[11px] text-muted-foreground">{t("routines.agents.reviewHint")}</p>
          {estimate && (
            <p className="text-xs">
              <span className="font-medium">{t("routines.agents.estimate")}</span>{" "}
              {t("routines.agents.estimateRange", { low: Math.round(estimate.low / 1000), high: Math.round(estimate.high / 1000) })}
              <span className="block text-[11px] text-muted-foreground">
                {estimate.basis === "history" ? t("routines.agents.estimateHistory", { count: estimate.runs }) : t("routines.agents.estimateGuess")}
              </span>
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">{t("routines.agents.note")}</p>
        </>
      )}
    </div>
  )
}
