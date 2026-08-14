import { useState } from "react"
import { useTranslation } from "react-i18next"
import { BrainIcon, ChevronDownIcon } from "lucide-react"
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
import { useProviderStore } from "@/src/stores/provider-store"

/**
 * Modal de configuração dos workers, compartilhado entre Subagents e Orchestra:
 * modelo do worker (só modelos com tool_call) + reasoning opcional com variant.
 * Sem worker configurado, o modelo principal é usado como fallback.
 */
export function OrchestrationConfigDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const catalog = useProviderStore((s) => s.catalog)
  const workerModel = useProviderStore((s) => s.workerModel)
  const workerReasoning = useProviderStore((s) => s.workerReasoning)
  const setWorkerModel = useProviderStore((s) => s.setWorkerModel)
  const setWorkerReasoning = useProviderStore((s) => s.setWorkerReasoning)
  const [pickerOpen, setPickerOpen] = useState(false)

  const selectedCatalogModel = workerModel
    ? catalog[workerModel.providerId]?.models[workerModel.modelId]
    : undefined
  const thinkingOn = workerReasoning?.enabled ?? false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("orchestrationConfig.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
            <strong>{t("orchestrationConfig.attention")}</strong> {t("orchestrationConfig.attentionText")}
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t("orchestrationConfig.workerModel")}</p>
            <Button
              variant="outline"
              className="h-8 w-full justify-start gap-1.5 px-2 text-xs font-normal"
              onClick={() => setPickerOpen(true)}
            >
              <ModelSelectorLogo provider={workerModel?.providerId ?? "openai"} />
              <ModelSelectorName>
                {workerModel
                  ? (catalog[workerModel.providerId]?.models[workerModel.modelId]?.name ?? workerModel.modelId)
                  : t("orchestrationConfig.useMainModel")}
              </ModelSelectorName>
              <ChevronDownIcon className="ml-auto size-3 text-muted-foreground" />
            </Button>
            <ModelPicker
              value={workerModel}
              onValueChange={(model) => {
                setWorkerModel(model)
                setWorkerReasoning(null)
              }}
              filter={(_provider, model) => model.tool_call !== false}
              nullLabel={t("orchestrationConfig.useMainModel")}
              hideTrigger
              open={pickerOpen}
              onOpenChange={setPickerOpen}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("orchestrationConfig.noSelectionHint")}
            </p>
          </div>

          {selectedCatalogModel?.reasoning && (
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() =>
                  setWorkerReasoning(thinkingOn ? null : { enabled: true, variantId: workerReasoning?.variantId })
                }
                className={
                  thinkingOn
                    ? "flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-foreground"
                    : "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground/60 hover:text-muted-foreground"
                }
              >
                <BrainIcon className="size-3.5" />
                {t("orchestrationConfig.thinkingOnWorker")}
              </button>
              {thinkingOn && (selectedCatalogModel.variants?.length ?? 0) > 0 && (
                <ReasoningPicker
                  variants={selectedCatalogModel.variants!}
                  enabled={thinkingOn}
                  selected={workerReasoning?.variantId}
                  onSelect={(id) => setWorkerReasoning({ enabled: true, variantId: id ?? undefined })}
                />
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {workerModel && (
            <Button
              variant="ghost"
              className="mr-auto text-xs text-muted-foreground"
              onClick={() => {
                setWorkerModel(null)
                setWorkerReasoning(null)
              }}
            >
              {t("orchestrationConfig.clear")}
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>{t("orchestrationConfig.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
