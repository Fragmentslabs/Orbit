import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeftIcon, ChevronDownIcon } from "lucide-react"
import { userProfileId } from "@shared/agents"
import type { PendingRoutine, RoutineModes, Schedule } from "@shared/routines"
import { applyAgentModes, DEFAULT_ROUTINE_PERMISSION, parseTime } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace-context"
import { BranchSelector } from "@/src/components/branch-selector"
import { useStartChatWith } from "@/src/hooks/use-creation-chat"
import { agentsAreValid, draftOf, emptyAgents, isTeam, soloAgent, storedFields, type AgentsDraft } from "@/src/lib/agents-draft"
import { lastUsedChat } from "@/src/lib/last-chat"
import { deriveTitle } from "@/src/lib/routine-title"
import { useAgents } from "@/src/stores/agents-store"
import type { SelectedModel } from "@/src/stores/provider-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { sessionModelFor, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { useSessionStore } from "@/src/stores/session-store"
import { AgentsEditor } from "./agents-editor"
import { ReviewerRow, TeamReview } from "./team-review"
import { AbilitiesField, Field, FoldersField } from "./form-parts"
import { describeWhen } from "./schedule"
import { ScheduleEditor } from "./schedule-editor"

type WhenKind = "schedule" | "event"

/**
 * "New routine" form, in two steps inside the same dialog:
 *
 *   1. What and when — what the routine does, and when: days and times, or "when something happens"
 *   2. Review — name, instruction, model, folders (optional), the agents and the advanced settings
 *
 * Creating normally happens in a chat; this form is for who prefers to fill it in, and for "See
 * details" on the card the chat proposed, which opens it already filled in. A trigger that is a
 * script (a price, a deploy, a page that changed) needs questions and code, so it goes to the chat.
 */
export function CreateRoutineDialog({
  open,
  onOpenChange,
  onCreated,
  proposal,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (routineId: string) => void
  /** A routine the chat proposed: the form opens filled in with it, and creating keeps the
   *  proposal's id so its card recognises the routine. */
  proposal?: PendingRoutine
}) {
  const { t } = useTranslation()
  // The page that opens the form seeds the working folders: a code page starts with the
  // workspace's folders attached, a chat page with none.
  const { mode: pageMode, folders: workspaceFolders } = useWorkspace()
  const allAgents = useAgents()
  const create = useRoutinesStore((s) => s.create)
  const sessions = useSessionStore((s) => s.sessions)
  const startChat = useStartChatWith()
  // Vision model configured in the preferences: it is what the routine stores when vision is on
  // (the main process does not read localStorage).
  const visionModel = useProviderStore((s) => s.visionModel)
  // How many adjustment rounds the reviewer gets per agent — a setting of the chat, shown read-only.
  const adjustmentsPerWorker = useProviderStore((s) => s.orchestrationSettings.adjustmentsPerWorker)

  const [step, setStep] = useState<1 | 2>(1)
  const [whenKind, setWhenKind] = useState<WhenKind>("schedule")
  const [prompt, setPrompt] = useState("")
  const [schedule, setSchedule] = useState<Schedule>({ time: "09:00" })
  const [title, setTitle] = useState("")
  const [model, setModel] = useState<SelectedModel | null>(null)
  const [folders, setFolders] = useState<string[]>([])
  const [agents, setAgents] = useState<AgentsDraft>(emptyAgents)
  const [modes, setModes] = useState<RoutineModes>({ permissionMode: DEFAULT_ROUTINE_PERMISSION })
  const [saving, setSaving] = useState(false)
  const team = isTeam(agents)

  /** A new routine starts on the model of the last chat used, like any new chat. */
  const fallback = useMemo<SelectedModel | null>(
    () => sessionModelFor(lastUsedChat(sessions, pageMode)?.id ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  )

  // Every opening starts over — reopening after creating a routine cannot bring back the draft.
  useEffect(() => {
    if (!open) return
    setStep(1)
    setWhenKind(proposal?.trigger ? "event" : "schedule")
    setPrompt(proposal?.prompt ?? "")
    setSchedule(proposal?.schedule ?? { time: "09:00" })
    setTitle(proposal?.title ?? "")
    setModel(proposal?.model ?? fallback)
    setFolders(proposal ? proposal.folders : pageMode === "chat" ? [] : workspaceFolders)
    const draft = proposal ? draftOf(proposal) : emptyAgents()
    // A team of two or more is reviewed by default: the members do not talk to each other, and the
    // reviewer is the only one that sees the whole plan. It costs more — the switch is right there.
    setAgents(isTeam(draft) && draft.review === undefined ? { ...draft, review: true } : draft)
    setModes(proposal?.modes ?? { permissionMode: DEFAULT_ROUTINE_PERMISSION })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // "Something happens" is built in the chat (questions + a script), unless the chat already did it.
  const needsChat = whenKind === "event" && !proposal?.trigger
  const watched = !!proposal?.trigger
  const canContinue = prompt.trim().length > 0 && !needsChat && (watched || !!parseTime(schedule.time))
  const canCreate = canContinue && !!model && title.trim().length > 0 && agentsAreValid(agents) && !saving

  const goToChat = (what: "prefer" | "event") => {
    const text = prompt.trim()
    const starter =
      what === "event"
        ? t("routines.form.eventStarter", { what: text })
        : text
          ? t("routines.form.preferStarter", { what: text })
          : t("creation.routine.starter")
    onOpenChange(false)
    void startChat(t("creation.routine.title"), starter)
  }

  const goToReview = () => {
    if (!title.trim()) setTitle(deriveTitle(prompt))
    setStep(2)
  }

  const handleCreate = async () => {
    if (!canCreate || !model) return
    setSaving(true)
    try {
      const stored = storedFields(agents)
      const selected = allAgents.find((a) => userProfileId(a.id) === stored.agent)
      // The agent decides the abilities.
      const effective = selected ? applyAgentModes(modes, selected.features) : modes
      const routine = await create({
        title: title.trim(),
        prompt: prompt.trim(),
        schedule,
        model,
        // Vision only works with the configured vision model: without one it is left off.
        modes: effective.vision && !visionModel ? { ...effective, vision: undefined } : effective,
        folders,
        // Kept whenever there is one: an agent that allows vision may switch it on later.
        visionModel: visionModel ?? undefined,
        ...stored,
        // Scripts and their trigger ride along from the agent's proposal (the form has no editor for them).
        ...(proposal?.scripts?.length ? { scripts: proposal.scripts, trigger: proposal.trigger } : {}),
        active: true,
        // The proposal's own id: its card finds the routine and turns into "created".
        ...(proposal ? { id: proposal.id } : {}),
      })
      useSessionModelPrefs.getState().markUsed(model.providerId, model.modelId)
      onOpenChange(false)
      onCreated?.(routine.id)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl overflow-hidden">
        <div className="flex items-center gap-3 pr-8">
          {step === 2 && (
            <Button variant="ghost" size="icon-sm" onClick={() => setStep(1)} aria-label={t("routines.review.back")}>
              <ArrowLeftIcon className="size-3.5" />
            </Button>
          )}
          <DialogTitle className="min-w-0 flex-1 truncate">{t("routines.create.title")}</DialogTitle>
          <StepPills step={step} labels={[t("routines.form.step1"), t("routines.form.step2")]} />
        </div>

        {step === 1 ? (
          <div key="step1" className="animate-in slide-in-from-left-8 fade-in-0 duration-200">
            <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
              <Field label={t("routines.form.whatItDoes")} hint={t("routines.form.whatItDoesHint")}>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t("routines.form.whatPlaceholder")}
                  className="max-h-56 min-h-28"
                />
              </Field>

              <Field label={t("routines.review.schedule")}>
                <div className="space-y-2">
                  <SegmentedControl<WhenKind>
                   
                    value={whenKind}
                    onChange={setWhenKind}
                    options={[
                      { value: "schedule", label: t("routines.form.whenSchedule") },
                      { value: "event", label: t("routines.form.whenEvent") },
                    ]}
                  />
                  {whenKind === "schedule" ? (
                    <ScheduleEditor schedule={schedule} onChange={setSchedule} />
                  ) : watched ? (
                    <p className="text-xs text-muted-foreground">{describeWhen({ schedule, trigger: proposal?.trigger }, t)}</p>
                  ) : (
                    <div className="space-y-2 rounded-lg border border-dashed p-3">
                      <p className="text-xs text-muted-foreground">{t("routines.form.eventExplain")}</p>
                      <Button onClick={() => goToChat("event")}>
                        {t("routines.form.eventContinue")}
                      </Button>
                    </div>
                  )}
                </div>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <FoldersField folders={folders} onChange={setFolders} />
                  {folders[0] && <BranchSelector repoPath={folders[0]} />}
                </div>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2 border-t pt-3">
              <Button variant="ghost" className="text-muted-foreground" onClick={() => goToChat("prefer")}>
                {t("routines.form.preferChat")}
              </Button>
              <span className="flex-1" />
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button disabled={!canContinue} onClick={goToReview}>
                {t("routines.form.next")}
              </Button>
            </div>
          </div>
        ) : (
          <div key="step2" className="animate-in slide-in-from-right-8 fade-in-0 duration-200">
            <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
              <Field label={t("routines.review.titleField")}>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 text-sm" />
              </Field>

              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <p className="flex-1 text-xs font-semibold">{t("routines.agents.teamTitle")}</p>
                  {team && (
                    <span className="rounded-md border bg-muted/40 px-1.5 py-px text-[10.5px] leading-4 text-muted-foreground">
                      {t("routines.agents.teamCount", { count: agents.members.length })}
                    </span>
                  )}
                </div>
                {proposal && team ? (
                  <div className="overflow-hidden rounded-xl border bg-card/40">
                    <TeamReview value={agents} onChange={setAgents} model={model} />
                    <ReviewerRow
                      review={agents.review === true}
                      onChange={(review) => setAgents({ ...agents, review })}
                      model={model}
                    />
                  </div>
                ) : (
                  <>
                    <AgentsEditor value={agents} onChange={setAgents} limits={false} />
                    {team && (
                      <div className="overflow-hidden rounded-xl border bg-card/40">
                        <ReviewerRow
                          review={agents.review === true}
                          onChange={(review) => setAgents({ ...agents, review })}
                          model={model}
                          border={false}
                        />
                      </div>
                    )}
                  </>
                )}
                {proposal && team && <p className="text-[10.5px] text-muted-foreground">{t("routines.agents.proposalTeam")}</p>}
              </div>

              <details className="group overflow-hidden rounded-xl border bg-card/40">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
                  <span className="text-xs font-semibold">{t("routines.form.advanced")}</span>
                  <span className="ml-auto text-[10.5px] text-muted-foreground">{t("routines.agents.limits")}</span>
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="divide-y border-t px-3 pb-1.5">
                  {team && (
                    <>
                      <LimitRow label={t("routines.agents.simultaneous")}>
                        <div className="inline-flex items-baseline gap-1 rounded-md border bg-background/50 px-2 py-0.5">
                          <input
                            type="number"
                            min={1}
                            max={8}
                            value={agents.maxParallel ?? ""}
                            placeholder="4"
                            onChange={(e) => setAgents({ ...agents, maxParallel: e.target.value ? Number(e.target.value) : undefined })}
                            className="w-6 bg-transparent text-center text-[11.5px] font-semibold tabular-nums outline-none"
                          />
                          <span className="text-[10px] text-muted-foreground">{t("routines.agents.ofMax", { max: 8 })}</span>
                        </div>
                      </LimitRow>
                      <LimitRow label={t("routines.agents.budget")}>
                        <div className="inline-flex items-baseline gap-1 rounded-md border bg-background/50 px-2 py-0.5">
                          <input
                            type="number"
                            min={1}
                            value={agents.tokenBudget ? Math.round(agents.tokenBudget / 1000) : ""}
                            placeholder="∞"
                            onChange={(e) => setAgents({ ...agents, tokenBudget: e.target.value ? Number(e.target.value) * 1000 : undefined })}
                            className="w-7 bg-transparent text-center text-[11.5px] font-semibold tabular-nums outline-none"
                          />
                          <span className="text-[10px] text-muted-foreground">{t("routines.agents.budgetUnit")}</span>
                        </div>
                      </LimitRow>
                      <LimitRow label={t("routines.agents.corrections")}>
                        <div className="inline-flex items-baseline gap-1 rounded-md border bg-background/50 px-2 py-0.5">
                          <span className="text-[11.5px] font-semibold tabular-nums">{adjustmentsPerWorker}</span>
                          <span className="text-[10px] text-muted-foreground">{t("routines.agents.perAgent")}</span>
                        </div>
                      </LimitRow>
                      <LimitRow label={t("routines.agents.onFailure")}>
                        <div
                          className="inline-flex min-w-32 items-center justify-between gap-2 rounded-md border bg-background/50 px-2 py-0.5"
                          title={t("routines.agents.onFailureHint")}
                        >
                          <span className="text-[11px]">{t("routines.agents.onFailureBranch")}</span>
                        </div>
                      </LimitRow>
                    </>
                  )}
                  <div className="py-2">
                    <AbilitiesField agent={soloAgent(agents)} team={team} modes={modes} onChange={setModes} />
                  </div>
                </div>
              </details>
            </div>
            <div className="mt-3 flex items-center gap-2 border-t pt-3">
              <Button variant="ghost" onClick={() => setStep(1)}>
                {t("routines.review.back")}
              </Button>
              <span className="flex-1" />
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button disabled={!canCreate} onClick={() => void handleCreate()}>
                {t("routines.review.create")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** One row of the "Advanced" block: the label on the left, the control on the right. */
function LimitRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className="flex-1 text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

/** "1 What and when — 2 Review", the way the design draws the steps. */
function StepPills({ step, labels }: { step: 1 | 2; labels: [string, string] }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {labels.map((label, index) => {
        const number = (index + 1) as 1 | 2
        const active = step === number
        const done = step > number
        return (
          <span key={label} className="flex items-center gap-2">
            {index > 0 && <span className="h-px w-5 bg-border" aria-hidden />}
            <span className={cn("flex items-center gap-1.5", active ? "font-medium text-foreground" : "text-muted-foreground")}>
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-full border text-[10px]",
                  (active || done) && "border-primary bg-primary text-primary-foreground",
                )}
              >
                {number}
              </span>
              {label}
            </span>
          </span>
        )
      })}
    </div>
  )
}
