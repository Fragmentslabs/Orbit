import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { BrainIcon } from "lucide-react"
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
import { ReasoningPicker } from "@/src/components/reasoning-picker"
import { useProviderStore } from "@/src/stores/provider-store"

const MAX_MODELS_PER_PROVIDER = 20

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
  const connectedProviders = useProviderStore((s) => s.connectedProviders)
  const workerModel = useProviderStore((s) => s.workerModel)
  const workerReasoning = useProviderStore((s) => s.workerReasoning)
  const setWorkerModel = useProviderStore((s) => s.setWorkerModel)
  const setWorkerReasoning = useProviderStore((s) => s.setWorkerReasoning)

  const groups = useMemo(
    () =>
      connectedProviders
        .filter((id) => catalog[id])
        .map((id) => ({
          provider: catalog[id],
          models: Object.values(catalog[id].models)
            .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""))
            .slice(0, MAX_MODELS_PER_PROVIDER),
        })),
    [catalog, connectedProviders],
  )

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
            <Select
              value={workerModel ? `${workerModel.providerId}/${workerModel.modelId}` : null}
              onValueChange={(value) => {
                if (typeof value !== "string") return
                const [providerId, ...rest] = value.split("/")
                setWorkerModel({ providerId, modelId: rest.join("/") })
                setWorkerReasoning(null)
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("orchestrationConfig.useMainModel")} />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {groups.map(({ provider, models }) => (
                  <SelectGroup key={provider.id}>
                    <SelectLabel>{provider.name}</SelectLabel>
                    {models.map((model) => (
                      <SelectItem
                        key={`${provider.id}/${model.id}`}
                        value={`${provider.id}/${model.id}`}
                        disabled={model.tool_call === false}
                      >
                        {model.name}
                        {model.tool_call === false ? ` (${t("orchestrationConfig.noTools")})` : ""}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
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
                  selected={workerReasoning?.variantId}
                  onSelect={(id) => setWorkerReasoning({ enabled: true, variantId: id })}
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
