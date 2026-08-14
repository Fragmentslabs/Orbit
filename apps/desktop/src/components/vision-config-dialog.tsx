import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Eye } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { modelSupportsVision } from "@shared/chat"
import { useProviderStore } from "@/src/stores/provider-store"

const MAX_MODELS_PER_PROVIDER = 20

/**
 * Configuração do modo Visão: escolhe o modelo de visão que DESCREVE imagens
 * para modelos sem visão (anexos e screenshots com ver: true). Só mostra
 * modelos com suporte a imagem. Sem modelo selecionado, o modo fica
 * desligado e o modelo principal não recebe imagens.
 */
export function VisionConfigDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const catalog = useProviderStore((s) => s.catalog)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)
  const visionModel = useProviderStore((s) => s.visionModel)
  const setVisionModel = useProviderStore((s) => s.setVisionModel)

  const groups = useMemo(
    () =>
      connectedProviders
        .filter((id) => catalog[id])
        .map((id) => ({
          provider: catalog[id],
          models: Object.values(catalog[id].models)
            .filter((model) => modelSupportsVision(catalog[id], model.id))
            .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""))
            .slice(0, MAX_MODELS_PER_PROVIDER),
        }))
        .filter((g) => g.models.length > 0),
    [catalog, connectedProviders],
  )

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
            <Select
              value={visionModel ? `${visionModel.providerId}/${visionModel.modelId}` : null}
              onValueChange={(value) => {
                if (typeof value !== "string") return
                const [providerId, ...rest] = value.split("/")
                setVisionModel({ providerId, modelId: rest.join("/") })
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("visionConfig.disabled")} />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {groups.map(({ provider, models }) => (
                  <SelectGroup key={provider.id}>
                    <SelectLabel>{provider.name}</SelectLabel>
                    {models.map((model) => (
                      <SelectItem key={`${provider.id}/${model.id}`} value={`${provider.id}/${model.id}`}>
                        {model.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
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
              onClick={() => setVisionModel(null)}
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
