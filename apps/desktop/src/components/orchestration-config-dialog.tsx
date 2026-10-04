import { useState } from "react"
import { useTranslation } from "react-i18next"
import { BrainIcon, ChevronDownIcon } from "lucide-react"
import type { ReasoningConfig } from "@shared/chat"
import { Button } from "@/components/ui/button"
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
 * Modelo + thinking de um papel da delegação. As mesmas preferências de
 * Preferências → Código (o estado vive na provider-store): mudar aqui muda lá.
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
          // Outro modelo, outros níveis: o raciocínio volta a desligado.
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

/**
 * Configuração da delegação, aberta pela engrenagem de Subagentes ou de Orquestra
 * no "+". Subagentes: o modelo dos workers. Orquestra: quem conduz (planeja e
 * escreve a resposta final) e os workers — os mesmos dos subagentes.
 */
export function OrchestrationConfigDialog({ kind, onOpenChange }: {
  /** null = fechado */
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
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{orchestra ? t("orchestrationConfig.titleOrchestra") : t("orchestrationConfig.titleSubagents")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
            <strong>{t("orchestrationConfig.attention")}</strong> {t("orchestrationConfig.attentionText")}
          </div>
          {orchestra && (
            <ModelSection
              label={t("orchestrationConfig.conductorModel")}
              hint={t("orchestrationConfig.conductorHint")}
              nullLabel={t("orchestrationConfig.useChatModel")}
              model={orchestratorModel}
              reasoning={orchestratorReasoning}
              onModelChange={setOrchestratorModel}
              onReasoningChange={setOrchestratorReasoning}
            />
          )}
          <ModelSection
            label={t("orchestrationConfig.workerModel")}
            hint={orchestra ? t("orchestrationConfig.workerSharedHint") : t("orchestrationConfig.noSelectionHint")}
            nullLabel={t("orchestrationConfig.useMainModel")}
            model={workerModel}
            reasoning={workerReasoning}
            onModelChange={setWorkerModel}
            onReasoningChange={setWorkerReasoning}
          />
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
