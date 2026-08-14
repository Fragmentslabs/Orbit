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
 * Configuração do modo Visão: escolhe o modelo de visão que DESCREVE imagens
 * para modelos sem visão (anexos e screenshots com ver: true). Só mostra
 * modelos com suporte a imagem. Sem modelo selecionado, o modo fica
 * desligado e o modelo principal não recebe imagens.
 *
 * O modelo é global; a ATIVAÇÃO é por chat (targetSession): escolher modelo
 * liga o modo para a sessão que abriu o dialog (undefined = chat novo).
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
                // Escolher modelo configura E ativa o modo (nesta sessão);
                // limpar desativa
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
