import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { BookOpenIcon, BrainIcon, ChevronDownIcon, GlobeIcon, PenLineIcon, SearchIcon, TerminalIcon, type LucideIcon } from "lucide-react"
import type { ProfileId, ReasoningConfig } from "@shared/chat"
import type { AllowedTool, PhaseChoice, PhaseTemplate } from "@shared/pipeline"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AgentMenu } from "@/src/components/routines/agent-menu"
import { ModelField } from "@/src/components/model-field"
import { ThinkingMenu } from "@/src/components/thinking-menu"
import { usePipelineStore } from "@/src/stores/pipeline-store"
import { useAgents } from "@/src/stores/agents-store"
import { useProviderStore } from "@/src/stores/provider-store"
import type { DefaultModel } from "@/src/stores/model-mode-prefs"
import { cn } from "@/lib/utils"

/**
 * What a phase may use, each with the icon it wears (the same pill language as
 * the routines). Reading is not a choice: a phase that cannot read cannot work,
 * so it is always on and shows as a fixed pill instead of a toggle.
 */
const CAPABILITIES: { id: AllowedTool; icon: LucideIcon }[] = [
  { id: "edit", icon: PenLineIcon },
  { id: "shell", icon: TerminalIcon },
  { id: "browser", icon: GlobeIcon },
  { id: "research", icon: SearchIcon },
  { id: "memory", icon: BrainIcon },
]

/**
 * Where to save the edited phase:
 *  - "pipeline": only the copy of this pipeline (D4), without contaminating
 *    other pipelines;
 *  - "original": the source template as well — applies to the next pipelines;
 *  - "new": becomes a new user template (shows up in "Add phase").
 */
export type PhaseDestination = "pipeline" | "original" | "new"

/** "Model · level" to show the phase without opening the editor. */
export function useModelLabel(
  providerId: string | undefined,
  modelId: string | undefined,
  reasoning: ReasoningConfig | null | undefined,
): string | null {
  const { t } = useTranslation()
  const model = useProviderStore((s) => (providerId && modelId ? s.catalog[providerId]?.models[modelId] : undefined))
  if (!providerId || !modelId) return null
  const name = model?.name ?? modelId
  if (!reasoning?.enabled) return name
  const variant = reasoning.variantId
  const level = variant
    ? t(`reasoning.variants.${variant}`, { defaultValue: model?.variants?.find((v) => v.id === variant)?.label ?? variant })
    : t("reasoning.variants.thinking")
  return `${name} · ${level}`
}

/**
 * Saves the template according to the destination and returns the phase already
 * pointing at it. The model does not go into the template: it is each
 * pipeline's choice. The specialist does: it is part of what the phase is.
 */
export function useSavePhaseTemplate() {
  const saveTemplate = usePipelineStore((s) => s.saveTemplate)
  const templates = usePipelineStore((s) => s.templates)
  return async (phase: PhaseChoice, destination: PhaseDestination): Promise<PhaseChoice> => {
    if (destination === "pipeline") return phase
    if (destination === "original" && !phase.templateId) return phase
    const id = destination === "new" ? `usr_${Date.now().toString(36)}` : phase.templateId!
    const original = templates.find((tpl) => tpl.id === id)
    const template: PhaseTemplate = {
      id,
      name: phase.name,
      description: phase.description,
      prompt: phase.prompt,
      ...(phase.noteContract ? { noteContract: phase.noteContract } : {}),
      tools: phase.tools,
      ...(phase.agent ? { agent: phase.agent } : {}),
      // Keeps the phase among the suggested ones if it already was, so the default does not vanish
      isDefault: original?.isDefault ?? false,
    }
    await saveTemplate(template)
    return { ...phase, templateId: id }
  }
}

/**
 * Phase editor, in two columns: on the left what the phase IS (name, description, the
 * specialist that runs it, model and capabilities); on the right what it does (the prompt),
 * with room to write. Saving sits on a split button in a pipeline — the main one touches only
 * this pipeline, the chevron reaches the original and "save as a new phase". In the phase
 * library there is nothing to split: it always writes the template.
 */
export function PhaseEditor({
  phase,
  open,
  defaultModel,
  defaultReasoning,
  onOpenChange,
  onSave,
  inheritsDefault = false,
  library = false,
}: {
  /** Phase being edited; absent = creating one from scratch */
  phase: PhaseChoice | null
  open: boolean
  /** Pipeline model/reasoning — what the phase uses when it has none of its own */
  defaultModel: DefaultModel | null
  defaultReasoning: ReasoningConfig | null
  /**
   * When creating the pipeline, the phase follows the "Default model" until it
   * gets one of its own — and can go back to following it through the "Use
   * default" link.
   */
  inheritsDefault?: boolean
  /** The phase library: one save button, writing the template itself. */
  library?: boolean
  onOpenChange: (open: boolean) => void
  onSave: (phase: PhaseChoice, destination: PhaseDestination) => void
}) {
  const { t } = useTranslation()
  const agents = useAgents()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [prompt, setPrompt] = useState("")
  const [noteContract, setNoteContract] = useState("")
  const [tools, setTools] = useState<AllowedTool[]>(["read"])
  const [agent, setAgent] = useState<ProfileId | undefined>(undefined)
  // The phase's own model. While there is none (`own` false), the editor shows
  // the default and the phase is saved without a model — it follows the
  // pipeline's.
  const [own, setOwn] = useState(false)
  const [model, setModel] = useState<DefaultModel | null>(null)
  const [reasoning, setReasoning] = useState<ReasoningConfig | null>(null)

  // Seeds only on open (and when the phase changes): the default arrives as a
  // new object on every render and, as a dependency, would wipe what is being typed.
  useEffect(() => {
    if (!open) return
    setName(phase?.name ?? "")
    setDescription(phase?.description ?? "")
    setPrompt(phase?.prompt ?? "")
    setNoteContract(phase?.noteContract ?? "")
    setTools(phase?.tools ?? ["read", "edit", "shell"])
    setAgent(phase?.agent)
    const hasOwn = !!phase?.providerId && !!phase.modelId
    setOwn(hasOwn)
    setModel(hasOwn ? { providerId: phase!.providerId!, modelId: phase!.modelId! } : null)
    setReasoning(hasOwn ? (phase?.reasoning ?? null) : null)
  }, [open, phase])

  const visibleModel = own ? model : defaultModel
  const visibleReasoning = own ? reasoning : defaultReasoning

  const toggleTool = (tool: AllowedTool) => {
    setTools((current) => (current.includes(tool) ? current.filter((x) => x !== tool) : [...current, tool]))
  }

  const valid = name.trim().length > 0 && prompt.trim().length > 0
  // A specialist deleted from the agents screen leaves the phase pointing at
  // nothing: say it instead of silently running as General.
  const missingAgent = !!agent && !agents.some((a) => a.id === agent)

  const save = (destination: PhaseDestination) => {
    if (!valid) return
    onSave(
      {
        templateId: phase?.templateId,
        name: name.trim(),
        description: description.trim(),
        prompt: prompt.trim(),
        ...(noteContract.trim() ? { noteContract: noteContract.trim() } : {}),
        tools,
        agent,
        // Without its own model the phase is saved without those fields: whoever saves uses the default.
        ...(own && model ? { providerId: model.providerId, modelId: model.modelId, reasoning } : {}),
      },
      destination,
    )
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogTitle>{phase ? t("pipeline.editPhase") : t("pipeline.newPhase")}</DialogTitle>

        <div className="grid max-h-[68vh] grid-cols-1 gap-4 overflow-y-auto pr-1 sm:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          {/* What the phase is. */}
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-xs font-medium">{t("pipeline.phaseName")}</p>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-sm" />
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium">{t("pipeline.phaseDescription")}</p>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="h-8 text-sm"
                placeholder={t("pipeline.phaseDescriptionHint")}
              />
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium">{t("pipeline.phaseAgent")}</p>
              <AgentMenu
                value={agent}
                onChange={setAgent}
                // A phase runs in a worktree and answers with a note: the craft setups
                // (motion, design, fragment) have nothing to work on here — and their
                // tools are the craft's, not the phase's.
                builtins={["general"]}
                excludeCraft
              />
              <p className="text-[11px] text-muted-foreground">{t("pipeline.phaseAgentHint")}</p>
              {missingAgent && (
                <p className="text-[11px] text-amber-500">{t("pipeline.phaseAgentMissing")}</p>
              )}
            </div>

            {/* A template carries no model: it is each pipeline's choice (see useSavePhaseTemplate). */}
            {!library && (
            <div className="space-y-1">
              <ModelField
                label={t("pipeline.phaseModel")}
                value={visibleModel}
                onChange={(m) => {
                  if (!m) return
                  setModel(m)
                  // Another model, other levels: back to off (as in Preferences);
                  // the same model keeps the level it already had.
                  const same = m.providerId === visibleModel?.providerId && m.modelId === visibleModel?.modelId
                  setReasoning(same ? visibleReasoning : null)
                  setOwn(true)
                }}
                action={
                  <>
                    <ThinkingMenu
                      model={visibleModel}
                      value={visibleReasoning}
                      onChange={(r) => {
                        setModel(visibleModel)
                        setReasoning(r)
                        setOwn(true)
                      }}
                    />
                    {inheritsDefault && own && (
                      <button
                        type="button"
                        onClick={() => setOwn(false)}
                        className="ml-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        {t("pipeline.useDefault")}
                      </button>
                    )}
                  </>
                }
              />
              {inheritsDefault && !own && (
                <p className="text-[11px] text-muted-foreground">{t("pipeline.followsDefault")}</p>
              )}
            </div>
            )}

            <div className="space-y-1">
              <p className="text-xs font-medium">{t("pipeline.phaseCapabilities")}</p>
              <div className="flex flex-wrap gap-1.5">
                {/* Reading is the floor of any phase: always on, not a toggle. */}
                <span
                  title={t("pipeline.phaseReadFixed")}
                  className="flex cursor-default items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] text-primary"
                >
                  <BookOpenIcon className="size-3" />
                  {t("pipeline.capability.read")}
                </span>
                {CAPABILITIES.map(({ id, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggleTool(id)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] transition-colors",
                      tools.includes(id)
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-accent",
                    )}
                  >
                    <Icon className="size-3" />
                    {t(`pipeline.capability.${id}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* What the phase does. */}
          <div className="flex min-h-0 flex-col gap-1">
            <p className="text-xs font-medium">{t("pipeline.phasePrompt")}</p>
            <p className="text-[11px] text-muted-foreground">{t("pipeline.phasePromptHint")}</p>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="min-h-[240px] w-full flex-1 resize-none rounded-md border bg-transparent px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus-visible:border-ring"
            />
            <p className="mt-2 text-xs font-medium">{t("pipeline.phaseNote")}</p>
            <p className="text-[11px] text-muted-foreground">{t("pipeline.phaseNoteHint")}</p>
            <textarea
              value={noteContract}
              onChange={(e) => setNoteContract(e.target.value)}
              placeholder={t("pipeline.phaseNotePlaceholder")}
              className="min-h-[96px] w-full resize-none rounded-md border bg-transparent px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus-visible:border-ring"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          {library ? (
            <Button disabled={!valid} onClick={() => save(phase?.templateId ? "original" : "new")}>
              {t("pipeline.save")}
            </Button>
          ) : (
            <div className="flex">
              <Button className="rounded-r-none" disabled={!valid} onClick={() => save("pipeline")}>
                {t("pipeline.saveInThisPipeline")}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={!valid}
                  aria-label={t("pipeline.moreSaveOptions")}
                  render={<Button className="rounded-l-none border-l border-primary-foreground/20 px-1.5" />}
                >
                  <ChevronDownIcon className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className="min-w-52">
                  <DropdownMenuItem disabled={!phase?.templateId} onClick={() => save("original")}>
                    {t("pipeline.saveToOriginal")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => save("new")}>
                    {t("pipeline.saveAsNewPhase")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
