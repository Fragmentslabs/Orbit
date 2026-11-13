import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { userProfileId } from "@shared/agents"
import type { Routine, RoutineModes, Schedule } from "@shared/routines"
import { applyAgentModes, isScriptTriggered, parseTime, ROUTINE_MODES } from "@shared/routines"
import {
  CalendarClockIcon,
  ChevronDownIcon,
  FolderIcon,
  ShieldIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { agentView } from "@/src/components/agent-meta"
import { agentsAreValid, draftOf, isTeam, soloAgent, storedFields, type AgentsDraft } from "@/src/lib/agents-draft"
import { routinesApi } from "@/src/lib/ipc"
import { useAgents } from "@/src/stores/agents-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { AbilitiesField, FoldersField } from "./form-parts"
import { describeWhen } from "./schedule"
import { ScheduleEditor } from "./schedule-editor"
import { TeamList } from "./team-list"

type Section = "what" | "when" | "who" | "where" | "abilities"
type FolderInfo = { folder: string; memory: string; scripts: string[] }

/**
 * The routine's settings, in the details panel: one accordion per group, each closed row
 * showing what is set today. There is no Save button — a change settles for a moment and goes to
 * the routine on its own, so the screen never lies about what is stored.
 *
 * The modal this replaces is gone; the panel is the only place a routine is edited.
 */
export function RoutineSettings({ routine }: { routine: Routine }) {
  const { t } = useTranslation()
  const agents = useAgents()
  const update = useRoutinesStore((s) => s.update)
  const visionModel = useProviderStore((s) => s.visionModel)

  const [title, setTitle] = useState(routine.title)
  const [prompt, setPrompt] = useState(routine.prompt)
  const [schedule, setSchedule] = useState<Schedule>(routine.schedule)
  const [modes, setModes] = useState<RoutineModes>(routine.modes)
  const [folders, setFolders] = useState<string[]>(routine.folders)
  const [draft, setDraft] = useState<AgentsDraft>(() => draftOf(routine))
  const [open, setOpen] = useState<Section | null>(null)
  const [folderInfo, setFolderInfo] = useState<FolderInfo | null>(null)
  const watched = isScriptTriggered(routine)

  // The routine's own folder: asked once, because old routines get one on first read.
  useEffect(() => {
    let alive = true
    setFolderInfo(null)
    routinesApi
      .folder(routine.id)
      .then((info) => {
        if (alive) setFolderInfo(info)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [routine.id])

  const fields = storedFields(draft)
  const snapshot = JSON.stringify({ title, prompt, schedule, modes, folders, fields })
  const saved = useRef(snapshot)
  const canSave =
    title.trim().length > 0 && prompt.trim().length > 0 && (watched || !!parseTime(schedule.time)) && agentsAreValid(draft)

  const persist = () => {
    saved.current = snapshot
    const stored = storedFields(draft)
    const selectedAgent = agents.find((a) => userProfileId(a.id) === stored.agent)
    const effective = selectedAgent ? applyAgentModes(modes, selectedAgent.features) : modes
    const keepsTeam = !!stored.team
    void update(routine.id, {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule,
      modes: effective.vision && !visionModel && !routine.visionModel ? { ...effective, vision: undefined } : effective,
      folders,
      agent: stored.agent,
      visionModel: routine.visionModel ?? visionModel ?? undefined,
      team: keepsTeam ? stored.team : undefined,
      tokenBudget: keepsTeam ? stored.tokenBudget : undefined,
      review: keepsTeam ? stored.review : undefined,
    })
  }

  // Autosave: the change is written after a short pause, so typing the prompt does not fire an
  // update per keystroke. `saved` keeps the last written snapshot, so the echo of our own update
  // (the routine coming back from the main process) never saves again.
  const latest = useRef({ snapshot, canSave, persist })
  latest.current = { snapshot, canSave, persist }

  useEffect(() => {
    if (snapshot === saved.current || !canSave) return
    const timer = setTimeout(() => latest.current.persist(), 700)
    return () => clearTimeout(timer)
  }, [snapshot, canSave])

  // Closing the panel right after typing still writes the change.
  useEffect(
    () => () => {
      if (latest.current.canSave && latest.current.snapshot !== saved.current) latest.current.persist()
    },
    [],
  )

  const solo = draft.members[0]?.agent ? agentView(draft.members[0].agent, agents, t) : agentView("general", agents, t)
  // Only the real modes: `permissionMode` lives in the same object but is a level, not an ability.
  const activeModes = ROUTINE_MODES.filter((key) => modes[key] === true).map((key) => t(`routines.modes.${key}.name`))

  const toggle = (section: Section) => setOpen((current) => (current === section ? null : section))

  return (
    <div className="flex flex-col">
      <Disclosure
        icon={SparklesIcon}
        label={t("routines.edit.what")}
        value={title}
        open={open === "what"}
        onToggle={() => toggle("what")}
      >
        <div className="space-y-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium">{t("routines.review.titleField")}</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium">{t("routines.review.promptField")}</span>
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="max-h-56 min-h-24 text-xs" />
          </label>
        </div>
      </Disclosure>

      <Disclosure
        icon={CalendarClockIcon}
        label={t("routines.edit.when")}
        value={describeWhen({ ...routine, schedule }, t)}
        open={open === "when"}
        onToggle={() => toggle("when")}
      >
        {watched ? (
          <p className="text-[11px] text-muted-foreground">{describeWhen(routine, t)}</p>
        ) : (
          <ScheduleEditor schedule={schedule} onChange={setSchedule} />
        )}
      </Disclosure>

      <Disclosure
        icon={UsersIcon}
        label={t("routines.edit.who")}
        value={isTeam(draft) ? t("routines.chat.agentCount", { count: draft.members.length }) : solo?.name}
        open={open === "who"}
        onToggle={() => toggle("who")}
      >
        <TeamList value={draft} onChange={setDraft} original={draftOf(routine)} modes={modes} routineId={routine.id} />
      </Disclosure>

      <Disclosure
        icon={FolderIcon}
        label={t("routines.edit.where")}
        value={folderName(folderInfo?.folder)}
        open={open === "where"}
        onToggle={() => toggle("where")}
      >
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-medium">{folderName(folderInfo?.folder)}</p>
              <p className="truncate text-[9.5px] text-muted-foreground">
                {folderInfo?.folder ?? t("routines.edit.folderLoading")}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-[10px]"
              disabled={!folderInfo}
              onClick={() => void routinesApi.openFolder(routine.id)}
            >
              {t("routines.edit.openFolder")}
            </Button>
          </div>
          <FoldersField folders={folders} onChange={setFolders} />
        </div>
      </Disclosure>

      <Disclosure
        icon={ShieldIcon}
        label={t("routines.edit.abilities")}
        value={activeModes.join(", ")}
        open={open === "abilities"}
        onToggle={() => toggle("abilities")}
      >
        <AbilitiesField agent={soloAgent(draft)} team={isTeam(draft)} modes={modes} onChange={setModes} />
      </Disclosure>

    </div>
  )
}

/** One line of the settings: icon, name, what is set today and the chevron that opens it. */
function Disclosure({
  icon: Icon,
  label,
  value,
  open,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="border-b border-border/50">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
        {value && <span className="max-w-24 shrink-0 truncate text-[10.5px] text-muted-foreground">{value}</span>}
        <ChevronDownIcon
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open && <div className="px-3 pt-2 pb-3">{children}</div>}
    </div>
  )
}

function folderName(folder?: string): string {
  return folder ? (folder.split(/[\\/]/).filter(Boolean).pop() ?? folder) : "…"
}
