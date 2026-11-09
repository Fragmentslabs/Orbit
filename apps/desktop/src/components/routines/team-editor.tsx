import { useTranslation } from "react-i18next"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { userProfileId } from "@shared/agents"
import type { ProfileId } from "@shared/chat"
import type { RoutineTeam, TeamMember } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useAgents } from "@/src/stores/agents-store"
import { EMPTY_TEAM, teamIsValid, withoutMember, type TeamDraft } from "@/src/lib/team-draft"

export { EMPTY_TEAM, teamIsValid, type TeamDraft }

let counter = 0
const newMemberId = () => `m${Date.now().toString(36)}${(counter++).toString(36)}`

const NUMBER_INPUT = "h-8 w-24 text-sm"

/**
 * Editor of a routine's team (optional: most routines have a single agent). Each member has a
 * name, an instruction, an agent and the members it waits for; the limits are how many work at the
 * same time and how many tokens one execution may spend.
 */
export function TeamEditor({ value, onChange }: { value: TeamDraft; onChange: (next: TeamDraft) => void }) {
  const { t } = useTranslation()
  const agents = useAgents()
  const { members } = value.team

  const setTeam = (team: RoutineTeam) => onChange({ ...value, team })
  const patch = (id: string, change: Partial<TeamMember>) =>
    setTeam({ ...value.team, members: members.map((m) => (m.id === id ? { ...m, ...change } : m)) })
  const toggleDependency = (member: TeamMember, otherId: string) => {
    const current = member.dependsOn ?? []
    patch(member.id, {
      dependsOn: current.includes(otherId) ? current.filter((d) => d !== otherId) : [...current, otherId],
    })
  }
  const add = () =>
    setTeam({ ...value.team, members: [...members, { id: newMemberId(), name: "", task: "" }] })

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-xs font-medium">{t("routines.team.title")}</p>
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={add}>
          <PlusIcon className="size-3.5" />
          {t("routines.team.add")}
        </Button>
      </div>
      {members.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-[11px] text-muted-foreground">{t("routines.team.empty")}</p>
      ) : (
        <>
          {members.map((member) => (
            <div key={member.id} className="space-y-2 rounded-lg border bg-card p-3">
              <div className="flex items-center gap-2">
                <Input
                  value={member.name}
                  onChange={(e) => patch(member.id, { name: e.target.value })}
                  placeholder={t("routines.team.namePlaceholder")}
                  className="h-8 flex-1 text-sm"
                />
                <select
                  value={member.agent ?? ""}
                  onChange={(e) => patch(member.id, { agent: (e.target.value || undefined) as ProfileId | undefined })}
                  className="h-8 max-w-40 rounded-md border bg-background px-2 text-xs"
                  aria-label={t("routines.team.agent")}
                >
                  <option value="">{t("routines.team.general")}</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={userProfileId(agent.id)}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-8"
                  onClick={() => setTeam(withoutMember(value.team, member.id))}
                  aria-label={t("routines.team.remove")}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
              <Input
                value={member.task}
                onChange={(e) => patch(member.id, { task: e.target.value })}
                placeholder={t("routines.team.taskPlaceholder")}
                className="h-8 text-sm"
              />
              {members.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">{t("routines.team.after")}</span>
                  {members
                    .filter((other) => other.id !== member.id)
                    .map((other) => {
                      const on = member.dependsOn?.includes(other.id) ?? false
                      return (
                        <button
                          key={other.id}
                          type="button"
                          onClick={() => toggleDependency(member, other.id)}
                          aria-pressed={on}
                          className={cn(
                            "rounded-md border px-2 py-0.5 text-[11px] transition-colors",
                            on ? "border-primary/60 bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {other.name.trim() || t("routines.team.unnamed")}
                        </button>
                      )
                    })}
                </div>
              )}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">{t("routines.team.parallel")}</span>
              <Input
                type="number"
                min={1}
                max={8}
                value={value.team.maxParallel ?? ""}
                placeholder="4"
                onChange={(e) => setTeam({ ...value.team, maxParallel: e.target.value ? Number(e.target.value) : undefined })}
                className={NUMBER_INPUT}
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">{t("routines.team.budget")}</span>
              <Input
                type="number"
                min={1}
                value={value.tokenBudget ? Math.round(value.tokenBudget / 1000) : ""}
                placeholder="∞"
                onChange={(e) => onChange({ ...value, tokenBudget: e.target.value ? Number(e.target.value) * 1000 : undefined })}
                className={NUMBER_INPUT}
              />
              <span className="text-muted-foreground">{t("routines.team.budgetUnit")}</span>
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("routines.team.note")}</p>
        </>
      )}
    </div>
  )
}
