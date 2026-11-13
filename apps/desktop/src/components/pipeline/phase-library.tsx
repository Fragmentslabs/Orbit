import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  BookOpenIcon,
  BrainIcon,
  CopyIcon,
  Ellipsis,
  GlobeIcon,
  LayersIcon,
  PenLineIcon,
  PlusIcon,
  SearchIcon,
  TerminalIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react"
import type { AllowedTool, PhaseChoice, PhaseTemplate } from "@shared/pipeline"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { agentView } from "@/src/components/agent-meta"
import { useAgents } from "@/src/stores/agents-store"
import { usePipelineStore } from "@/src/stores/pipeline-store"
import { PhaseEditor, useSavePhaseTemplate, type PhaseDestination } from "./phase-editor"

/** Icon per capability, the same set the phase editor wears. */
const TOOL_ICON: Record<AllowedTool, LucideIcon> = {
  read: BookOpenIcon,
  edit: PenLineIcon,
  shell: TerminalIcon,
  browser: GlobeIcon,
  research: SearchIcon,
  memory: BrainIcon,
}

type Filter = "all" | "native" | "mine"

/**
 * The phase library: every phase a pipeline may start from — the native ones and the person's —
 * as cards, each showing what it may use, which specialist runs it and how many pipelines already
 * run it. A click opens the same editor the pipelines use, in "library" mode: saving writes the
 * template itself, not a copy of one pipeline.
 */
export function PhaseLibrary() {
  const { t } = useTranslation()
  const templates = usePipelineStore((s) => s.templates)
  const pipelines = usePipelineStore((s) => s.pipelines)
  const saveTemplate = usePipelineStore((s) => s.saveTemplate)
  const removeTemplate = usePipelineStore((s) => s.removeTemplate)
  const savePhaseTemplate = useSavePhaseTemplate()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  // undefined = the editor is closed; null = creating a phase from scratch.
  const [editing, setEditing] = useState<PhaseTemplate | null | undefined>(undefined)
  const [deleting, setDeleting] = useState<PhaseTemplate | null>(null)

  // Built-in phases carry a translation key; the person's show what they wrote.
  const label = useCallback(
    (tpl: PhaseTemplate) =>
      tpl.i18nKey && !tpl.custom
        ? { name: t(`pipeline.phase.${tpl.i18nKey}.name`), description: t(`pipeline.phase.${tpl.i18nKey}.description`) }
        : { name: tpl.name, description: tpl.description },
    [t],
  )

  const usedIn = (id: string) => pipelines.filter((p) => p.phases.some((phase) => phase.templateId === id)).length

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return templates.filter((tpl) => {
      if (filter === "native" && tpl.custom) return false
      if (filter === "mine" && !tpl.custom) return false
      if (!q) return true
      const text = label(tpl)
      return [text.name, text.description, tpl.prompt].some((field) => field.toLowerCase().includes(q))
    })
  }, [templates, query, filter, label])

  const choiceOf = (tpl: PhaseTemplate): PhaseChoice => ({
    templateId: tpl.id,
    ...label(tpl),
    prompt: tpl.prompt,
    ...(tpl.noteContract ? { noteContract: tpl.noteContract } : {}),
    tools: [...tpl.tools],
    agent: tpl.agent,
  })

  const save = async (phase: PhaseChoice, destination: PhaseDestination) => {
    await savePhaseTemplate(phase, destination)
    setEditing(undefined)
  }

  const duplicate = async (tpl: PhaseTemplate) => {
    const text = label(tpl)
    await saveTemplate({
      id: `usr_${Date.now().toString(36)}`,
      name: `${text.name} 2`,
      description: text.description,
      prompt: tpl.prompt,
      ...(tpl.noteContract ? { noteContract: tpl.noteContract } : {}),
      tools: [...tpl.tools],
      isDefault: false,
      custom: true,
      userCreated: true,
      ...(tpl.agent ? { agent: tpl.agent } : {}),
    })
  }

  const chips: { id: Filter; label: string }[] = [
    { id: "all", label: t("pipeline.library.all") },
    { id: "native", label: t("pipeline.library.native") },
    { id: "mine", label: t("pipeline.library.mine") },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
          <SearchIcon className="size-3.5 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("pipeline.library.search")}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
        <Button onClick={() => setEditing(null)}>
          <PlusIcon className="size-3.5" />
          {t("pipeline.library.new")}
        </Button>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            onClick={() => setFilter(chip.id)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
              filter === chip.id
                ? "border-primary/40 bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {chip.label}
          </button>
        ))}
        <span className="ml-auto text-[10.5px] text-muted-foreground">
          {t("pipeline.library.count", { count: visible.length })}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {visible.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
            {t("pipeline.library.empty")}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((tpl) => (
              <PhaseCard
                key={tpl.id}
                template={tpl}
                label={label(tpl)}
                used={usedIn(tpl.id)}
                onEdit={() => setEditing(tpl)}
                onDuplicate={() => void duplicate(tpl)}
                onDelete={() => setDeleting(tpl)}
              />
            ))}
          </div>
        )}
      </div>

      <PhaseEditor
        phase={editing ? choiceOf(editing) : null}
        open={editing !== undefined}
        defaultModel={null}
        defaultReasoning={null}
        library
        onOpenChange={(open) => {
          if (!open) setEditing(undefined)
        }}
        onSave={(phase, destination) => void save(phase, destination)}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title={deleting?.userCreated ? t("pipeline.library.deleteTitle") : t("pipeline.library.resetTitle")}
        description={
          deleting?.userCreated
            ? t("pipeline.library.deleteBody", { name: label(deleting).name })
            : t("pipeline.library.resetBody", { name: deleting ? label(deleting).name : "" })
        }
        confirmLabel={deleting?.userCreated ? t("pipeline.library.delete") : t("pipeline.library.reset")}
        destructive
        onConfirm={() => {
          if (deleting) void removeTemplate(deleting.id)
          setDeleting(null)
        }}
      />
    </div>
  )
}

/**
 * One phase, as a card: who runs it (the specialist's icon), what it is, what it may use and how
 * many pipelines already run it. The name carries the click target; the menu floats above it.
 */
function PhaseCard({
  template,
  label,
  used,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  template: PhaseTemplate
  label: { name: string; description: string }
  used: number
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const agents = useAgents()
  const view = agentView(template.agent ?? "general", agents, t)
  const Icon = view?.icon ?? LayersIcon

  return (
    <div className="relative flex flex-col gap-2 rounded-[10px] border bg-card p-2.5 transition-colors hover:bg-accent/40">
      <div className="flex items-start gap-2">
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-[8px] bg-muted/60", view?.color ?? "text-muted-foreground")}>
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={onEdit}
              className="min-w-0 truncate text-left text-[12.5px] font-semibold after:absolute after:inset-0 after:cursor-pointer after:content-['']"
            >
              {label.name}
            </button>
            <span className="shrink-0 rounded border px-1 py-px text-[9px] text-muted-foreground">
              {template.custom ? t("pipeline.library.mineBadge") : t("pipeline.library.nativeBadge")}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-muted-foreground">{label.description}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("pipeline.phaseOptions")}
            className="relative z-10 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Ellipsis className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onClick={onEdit}>{t("pipeline.library.edit")}</DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate}>
              <CopyIcon className="size-3.5" />
              {t("pipeline.library.duplicate")}
            </DropdownMenuItem>
            {template.custom && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onClick={onDelete}>
                  <Trash2Icon className="size-3.5" />
                  {template.userCreated ? t("pipeline.library.delete") : t("pipeline.library.reset")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex items-center gap-1.5 text-muted-foreground/70">
        {template.tools.map((tool) => {
          const ToolIcon = TOOL_ICON[tool]
          return <ToolIcon key={tool} className="size-3" />
        })}
        <span className="ml-auto text-[9.5px] text-muted-foreground">
          {used > 0 ? t("pipeline.library.usedIn", { count: used }) : t("pipeline.library.unused")}
        </span>
      </div>
    </div>
  )
}
