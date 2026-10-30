import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon, Eye } from "lucide-react"
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
import { modelSupportsVision } from "@shared/chat"
import { useProviderStore } from "@/src/stores/provider-store"
import { useModeOverrides } from "@/src/stores/mode-overrides"

/**
 * Vision mode settings: it chooses the vision model that DESCRIBES images
 * for models without vision (attachments and screenshots with see: true). It only shows
 * models with image support. With no model selected, the mode stays
 * off and the main model does not receive images.
 *
 * The model is global; the ACTIVATION is per chat (targetSession): choosing a model
 * turns the mode on for the session that opened the dialog (undefined = new chat).
 */
export function VisionConfigDialog({ open, onOpenChange, targetSession }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetSession?: string
}) {
  const { t } = useTranslation()
  const catalog = useProviderStore((s) => s.catalog)
  const visionModel = useProviderStore((s) => s.visionModel)
  const setVisionModel = useProviderStore((s) => s.setVisionModel)
  const setModeActive = useModeOverrides((s) => s.setMode)
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("visionConfig.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-primary/30 bg-primary/10 p-2 text-xs text-foreground/80">
            <Eye className="mr-1 inline size-3.5 align-[-2px]" />
            {t("visionConfig.explainer")}
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t("visionConfig.visionModel")}</p>
            <Button
              variant="outline"
              className="h-8 w-full justify-start gap-1.5 px-2 text-xs font-normal"
              onClick={() => setPickerOpen(true)}
            >
              <ModelSelectorLogo provider={visionModel?.providerId ?? "openai"} />
              <ModelSelectorName>
                {visionModel
                  ? (catalog[visionModel.providerId]?.models[visionModel.modelId]?.name ?? visionModel.modelId)
                  : t("visionConfig.disabled")}
              </ModelSelectorName>
              <ChevronDownIcon className="ml-auto size-3 text-muted-foreground" />
            </Button>
            <ModelPicker
              value={visionModel}
              onValueChange={(model) => {
                // Choosing a model configures AND turns the mode on (in this session);
                // clearing it turns it off
                setVisionModel(model)
                setModeActive("vision", targetSession, model != null)
              }}
              filter={(provider, model) => modelSupportsVision(provider, model.id)}
              nullLabel={t("visionConfig.disabled")}
              hideTrigger
              open={pickerOpen}
              onOpenChange={setPickerOpen}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("visionConfig.noSelectionHint")}
            </p>
          </div>
        </div>

        <DialogFooter>
          {visionModel && (
            <Button
              variant="ghost"
              className="mr-auto text-xs text-muted-foreground"
              onClick={() => {
                setVisionModel(null)
                setModeActive("vision", targetSession, false)
              }}
            >
              {t("visionConfig.disable")}
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>{t("visionConfig.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
