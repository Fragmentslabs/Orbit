import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { BrainIcon, ChevronDownIcon, MinusIcon, PlusIcon } from "lucide-react"
import type { OrchestrationSettings, ReasoningConfig } from "@shared/chat"
import { MAX_ADJUSTMENTS_PER_WORKER } from "@shared/chat"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ModelSelectorLogo, ModelSelectorName } from "@/src/components/ai/model-selector"
import { ModelPicker } from "@/src/components/model-picker"
import { ReasoningPicker } from "@/src/components/reasoning-picker"
import { useProviderStore, type SelectedModel } from "@/src/stores/provider-store"

export type DelegationConfigKind = "subagents" | "orchestra"

/**
 * Model + thinking of a delegation role. The same preferences as
 * Preferences → Code (the state lives in the provider store): changing it here
 * changes it there.
 */
function ModelSection({
  label,
  hint,
  nullLabel,
  model,
  reasoning,
  onModelChange,
  onReasoningChange,
}: {
  label: string
  hint: string
  nullLabel: string
  model: SelectedModel | null
  reasoning: ReasoningConfig | null
  onModelChange: (model: SelectedModel | null) => void
  onReasoningChange: (reasoning: ReasoningConfig | null) => void
}) {
  const { t } = useTranslation()
  const catalog = useProviderStore((s) => s.catalog)
  const [pickerOpen, setPickerOpen] = useState(false)
  const catalogModel = model ? catalog[model.providerId]?.models[model.modelId] : undefined
  const thinkingOn = reasoning?.enabled ?? false

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <Button
        variant="outline"
        className="h-8 w-full justify-start gap-1.5 px-2 text-xs font-normal"
        onClick={() => setPickerOpen(true)}
      >
        <ModelSelectorLogo provider={model?.providerId ?? "openai"} />
        <ModelSelectorName>{model ? (catalogModel?.name ?? model.modelId) : nullLabel}</ModelSelectorName>
        <ChevronDownIcon className="ml-auto size-3 text-muted-foreground" />
      </Button>
      <ModelPicker
        value={model}
        onValueChange={(next) => {
          onModelChange(next)
          // Another model, other levels: reasoning goes back to off.
          onReasoningChange(null)
        }}
        filter={(_provider, m) => m.tool_call !== false}
        nullLabel={nullLabel}
        hideTrigger
        open={pickerOpen}
        onOpenChange={setPickerOpen}
      />
      <p className="text-[11px] text-muted-foreground">{hint}</p>

      {catalogModel?.reasoning && (
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onReasoningChange(thinkingOn ? null : { enabled: true, variantId: reasoning?.variantId })}
            className={
              thinkingOn
                ? "flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-foreground"
                : "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground/60 hover:text-muted-foreground"
            }
          >
            <BrainIcon className="size-3.5" />
            {t("orchestrationConfig.thinking")}
          </button>
          {thinkingOn && (catalogModel.variants?.length ?? 0) > 0 && (
            <ReasoningPicker
              variants={catalogModel.variants!}
              enabled={thinkingOn}
              selected={reasoning?.variantId}
              onSelect={(id) => onReasoningChange({ enabled: true, variantId: id ?? undefined })}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** Modal block: a title and the frame that splits the panel into two columns. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <p className="text-xs font-medium">{title}</p>
      {children}
    </section>
  )
}

/**
 * Delegation settings, opened by the Subagents or Orchestra gear in the "+".
 * Subagents: the workers' model. Orchestra: who conducts (plans and writes the
 * final answer) and the workers — the same ones as the subagents.
 */
export function OrchestrationConfigDialog({ kind, onOpenChange }: {
  /** null = closed */
  kind: DelegationConfigKind | null
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const workerModel = useProviderStore((s) => s.workerModel)
  const workerReasoning = useProviderStore((s) => s.workerReasoning)
  const setWorkerModel = useProviderStore((s) => s.setWorkerModel)
  const setWorkerReasoning = useProviderStore((s) => s.setWorkerReasoning)
  const orchestratorModel = useProviderStore((s) => s.orchestratorModel)
  const orchestratorReasoning = useProviderStore((s) => s.orchestratorReasoning)
  const setOrchestratorModel = useProviderStore((s) => s.setOrchestratorModel)
  const setOrchestratorReasoning = useProviderStore((s) => s.setOrchestratorReasoning)
  const orchestra = kind === "orchestra"

  const hasSelection = Boolean(workerModel || (orchestra && orchestratorModel))
  const clear = () => {
    setWorkerModel(null)
    setWorkerReasoning(null)
    if (orchestra) {
      setOrchestratorModel(null)
      setOrchestratorReasoning(null)
    }
  }

  return (
    <Dialog open={kind !== null} onOpenChange={onOpenChange}>
      {/* Orchestra has too much configuration for a single column: the roles
          (orchestrator, worker) sit on the left and the behavior on the right,
          instead of a list taller than the screen. */}
      <DialogContent className={orchestra ? "sm:max-w-3xl" : "sm:max-w-sm"} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{orchestra ? t("orchestrationConfig.titleOrchestra") : t("orchestrationConfig.titleSubagents")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
            <strong>{t("orchestrationConfig.attention")}</strong> {t("orchestrationConfig.attentionText")}
          </div>
          {orchestra ? (
            <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
              <Section title={t("orchestrationConfig.modelsTitle")}>
                <ModelSection
                  label={t("orchestrationConfig.conductorModel")}
                  hint={t("orchestrationConfig.conductorHint")}
                  nullLabel={t("orchestrationConfig.useChatModel")}
                  model={orchestratorModel}
                  reasoning={orchestratorReasoning}
                  onModelChange={setOrchestratorModel}
                  onReasoningChange={setOrchestratorReasoning}
                />
                <ModelSection
                  label={t("orchestrationConfig.workerModel")}
                  hint={t("orchestrationConfig.workerSharedHint")}
                  nullLabel={t("orchestrationConfig.useMainModel")}
                  model={workerModel}
                  reasoning={workerReasoning}
                  onModelChange={setWorkerModel}
                  onReasoningChange={setWorkerReasoning}
                />
              </Section>
              <BehaviorSection />
            </div>
          ) : (
            <ModelSection
              label={t("orchestrationConfig.workerModel")}
              hint={t("orchestrationConfig.noSelectionHint")}
              nullLabel={t("orchestrationConfig.useMainModel")}
              model={workerModel}
              reasoning={workerReasoning}
              onModelChange={setWorkerModel}
              onReasoningChange={setWorkerReasoning}
            />
          )}
        </div>

        <DialogFooter>
          {hasSelection && (
            <Button variant="ghost" className="mr-auto text-xs text-muted-foreground" onClick={clear}>
              {t("orchestrationConfig.clear")}
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>{t("orchestrationConfig.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * How the orchestrator behaves after splitting the work. Applies to the next
 * approved plans — a plan in progress follows the configuration it was approved
 * with.
 */
function BehaviorSection() {
  const { t } = useTranslation()
  const settings = useProviderStore((s) => s.orchestrationSettings)
  const update = useProviderStore((s) => s.setOrchestrationSettings)
  const options: Array<{ id: OrchestrationSettings["behavior"]; label: string; hint: string }> = [
    { id: "orchestrate", label: t("orchestrationConfig.behavior.orchestrate"), hint: t("orchestrationConfig.behavior.orchestrateHint") },
    { id: "supervise", label: t("orchestrationConfig.behavior.follow"), hint: t("orchestrationConfig.behavior.followHint") },
    { id: "rigorous", label: t("orchestrationConfig.behavior.strict"), hint: t("orchestrationConfig.behavior.strictHint") },
  ]
  const reviews = settings.behavior !== "orchestrate"

  return (
    <Section title={t("orchestrationConfig.behavior.title")}>
      <div className="flex flex-col gap-1.5">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => update({ behavior: o.id })}
            className={cn(
              "flex flex-col items-start rounded-md border px-2.5 py-1.5 text-left transition-colors",
              settings.behavior === o.id ? "border-primary/50 bg-primary/10" : "hover:bg-accent/50",
            )}
          >
            <span className="text-xs font-medium">{o.label}</span>
            <span className="text-[11px] leading-tight text-muted-foreground">{o.hint}</span>
          </button>
        ))}
      </div>

      <div className={cn("flex items-center gap-3", !reviews && "opacity-50")}>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{t("orchestrationConfig.behavior.adjustments")}</p>
          <p className="text-[11px] leading-tight text-muted-foreground">{t("orchestrationConfig.behavior.adjustmentsHint")}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            className="size-6"
            disabled={!reviews || settings.adjustmentsPerWorker <= 0}
            onClick={() => update({ adjustmentsPerWorker: settings.adjustmentsPerWorker - 1 })}
            aria-label={t("orchestrationConfig.behavior.less")}
          >
            <MinusIcon className="size-3" />
          </Button>
          <span className="w-5 text-center text-xs tabular-nums">{settings.adjustmentsPerWorker}</span>
          <Button
            variant="outline"
            size="icon-sm"
            className="size-6"
            disabled={!reviews || settings.adjustmentsPerWorker >= MAX_ADJUSTMENTS_PER_WORKER}
            onClick={() => update({ adjustmentsPerWorker: settings.adjustmentsPerWorker + 1 })}
            aria-label={t("orchestrationConfig.behavior.more")}
          >
            <PlusIcon className="size-3" />
          </Button>
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{t("orchestrationConfig.behavior.worktrees")}</p>
          <p className="text-[11px] leading-tight text-muted-foreground">{t("orchestrationConfig.behavior.worktreesHint")}</p>
        </div>
        <Switch checked={settings.worktrees} onCheckedChange={(v) => update({ worktrees: v })} />
      </label>

      <label className="flex cursor-pointer items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{t("orchestrationConfig.behavior.approveSingleTask")}</p>
          <p className="text-[11px] leading-tight text-muted-foreground">{t("orchestrationConfig.behavior.approveSingleTaskHint")}</p>
        </div>
        <Switch checked={settings.approveSingleTask} onCheckedChange={(v) => update({ approveSingleTask: v })} />
      </label>

      <label className="flex cursor-pointer items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{t("orchestrationConfig.behavior.autoApprove")}</p>
          <p className="text-[11px] leading-tight text-muted-foreground">{t("orchestrationConfig.behavior.autoApproveHint")}</p>
        </div>
        <Switch checked={settings.autoApprove} onCheckedChange={(v) => update({ autoApprove: v })} />
      </label>
    </Section>
  )
}
