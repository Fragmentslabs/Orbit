import { useState } from "react"
import { useTranslation } from "react-i18next"
import { userProfileId } from "@shared/agents"
import type { ProfileId } from "@shared/chat"
import type { RoutineModes } from "@shared/routines"
import { applyAgentModes } from "@shared/routines"
import { ArrowRightIcon, PencilIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { isTeam, waitsFor, type AgentsDraft } from "@/src/lib/agents-draft"
import { agentView } from "@/src/components/agent-meta"
import { routinesApi } from "@/src/lib/ipc"
import { useAgents } from "@/src/stores/agents-store"
import { useDraftInput } from "@/src/stores/draft-input"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { AgentMenu } from "./agent-menu"

/**
 * "Quem executa" as a list — one row per member, with the agent selector on the left (the order
 * is the list itself, so no number), the role next to it, the step it waits for on the right and
 * the instruction cut to a line. The pencil opens the instruction in a small dialog: it is the
 * only part of a member a person edits directly; the order and who is in the team still go
 * through the routine's chat.
 */
export function TeamList({
  value,
  onChange,
  original,
  modes,
  routineId,
  onRequestChange,
}: {
  value: AgentsDraft
  onChange: (next: AgentsDraft) => void
  /** The routine as it is stored — a swap only counts when it differs from this. */
  original: AgentsDraft
  /** What the routine uses: a swapped agent that cannot do it is flagged under the row. */
  modes: RoutineModes
  routineId: string
  /** Leaves the routine screen: the change lives in the routine's chat, behind it. */
  onRequestChange?: () => void
}) {
  const { t } = useTranslation()
  const agents = useAgents()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [taskDraft, setTaskDraft] = useState("")
  const team = isTeam(value)
  const fallback = agentView("general", agents, t)!
  const views = value.members.map((member) => (member.agent ? agentView(member.agent, agents, t) : null) ?? fallback)
  const editingIndex = editingId ? value.members.findIndex((member) => member.id === editingId) : -1
  const editing = editingIndex >= 0 ? value.members[editingIndex] : null
  const editingView = editingIndex >= 0 ? views[editingIndex] : fallback

  const facts: string[] = []
  if (value.maxParallel) facts.push(t("routines.team.factsParallel", { count: value.maxParallel }))
  if (value.tokenBudget) facts.push(t("routines.team.factsBudget", { value: Math.round(value.tokenBudget / 1000) }))
  if (value.review) facts.push(t("routines.team.factsReview"))

  const swap = (id: string, agent: ProfileId | undefined) => {
    onChange({ ...value, members: value.members.map((member) => (member.id === id ? { ...member, agent } : member)) })
  }

  // What the swapped agent cannot do that the routine uses. Only for an agent that really
  // changed — an old gap is not this form's business.
  const lossesOf = (id: string, agent: ProfileId | undefined): (keyof RoutineModes)[] => {
    const before = original.members.find((member) => member.id === id) ?? (original.members.length === 1 ? original.members[0] : undefined)
    if (!before || before.agent === agent) return []
    const chosen = agent ? agents.find((a) => userProfileId(a.id) === agent) : undefined
    const effective = chosen ? applyAgentModes(modes, chosen.features) : modes
    return (Object.keys(modes) as (keyof RoutineModes)[]).filter((key) => modes[key] && !effective[key])
  }

  // The request lives in the routine's chat: open the routine and leave the composer with the
  // beginning of the sentence for the person to finish.
  const requestChange = async () => {
    onRequestChange?.()
    const session = await routinesApi.chatSession(routineId).catch(() => null)
    if (session?.id) useDraftInput.getState().setDraft(session.id, t("routines.team.changeRequest"))
    useRoutinesStore.getState().open(routineId)
  }

  const openTask = (id: string, task: string) => {
    setEditingId(id)
    setTaskDraft(task)
  }

  const saveTask = () => {
    if (!editingId) return
    onChange({
      ...value,
      members: value.members.map((member) => (member.id === editingId ? { ...member, task: taskDraft.trim() } : member)),
    })
    setEditingId(null)
  }

  return (
    <div className="space-y-2.5">
      <div className="overflow-hidden rounded-lg border">
        {value.members.map((member, index) => {
          const view = views[index]
          const waits = waitsFor(member, value.members, t("routines.agents.unnamed"))
          const task = member.task.trim()
          const losses = lossesOf(member.id, member.agent)
          return (
            <div key={member.id} className={cn("px-2.5 py-2", index > 0 && "border-t")}>
              <div className="flex items-center gap-1.5">
                <AgentMenu
                  value={member.agent}
                  onChange={(agent) => swap(member.id, agent)}
                  compact
                  className="size-7"
                  onManage={onRequestChange}
                />
                <p className="min-w-0 flex-1 truncate text-xs font-medium">{team ? member.name.trim() || view.name : view.name}</p>
                {team && (
                  <span className="max-w-24 shrink-0 truncate rounded-md bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                    {waits.length === 0
                      ? t("routines.agents.stageFirst")
                      : t("routines.agents.stageAfter", { names: waits.join(", ") })}
                  </span>
                )}
                {team && (
                  <button
                    type="button"
                    onClick={() => openTask(member.id, member.task)}
                    aria-label={t("routines.team.editTask")}
                    title={t("routines.team.editTask")}
                    className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <PencilIcon className="size-3" />
                  </button>
                )}
              </div>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">
                {team ? task || t("routines.agents.taskPlaceholder") : view.description}
              </p>
              {losses.length > 0 && (
                <p className="mt-1 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                  {t("routines.team.loses", {
                    abilities: losses.map((key) => t("routines.modes." + key + ".name")).join(", "),
                  })}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {team && facts.length > 0 && <p className="text-[11px] text-muted-foreground">{facts.join(" · ")}</p>}

      <Button
        variant="ghost"
        className="-ml-2 h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => void requestChange()}
      >
        {t("routines.team.request")}
        <ArrowRightIcon className="size-3" />
      </Button>

      <Dialog open={!!editing} onOpenChange={(next) => !next && setEditingId(null)}>
        <DialogContent className="max-w-[520px] gap-0 p-0" showCloseButton={false}>
          <DialogTitle className="sr-only">{t("routines.team.editTask")}</DialogTitle>
          <header className="border-b px-5 py-4">
            <h2 className="text-sm font-semibold">
              {t("routines.team.editTaskTitle", { name: editing?.name.trim() || editingView.name })}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("routines.team.editTaskHint")}</p>
          </header>
          <div className="p-5">
            <Textarea
              autoFocus
              value={taskDraft}
              onChange={(e) => setTaskDraft(e.target.value)}
              className="min-h-40 text-sm"
            />
          </div>
          <footer className="flex items-center justify-end gap-2 border-t px-5 py-3">
            <Button variant="ghost" onClick={() => setEditingId(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!taskDraft.trim()} onClick={saveTask}>
              {t("routines.list.save")}
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
    </div>
  )
}
