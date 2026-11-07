import type { FragmentManifest } from "@shared/fragments"
import { useTranslation } from "react-i18next"
import { ModelPicker } from "@/src/components/model-picker"
import { fragmentApi } from "@/src/lib/ipc"

/**
 * The model a fragment's page gets when it calls `orbit.ai`. In the header it shows as a
 * trigger; when the header runs out of room it is opened from the actions menu instead
 * (`open` / `onOpenChange`, trigger hidden).
 */
export function FragmentModelPicker({
  manifest,
  open,
  onOpenChange,
}: {
  manifest: FragmentManifest
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <ModelPicker
      value={manifest.model ?? null}
      onValueChange={(model) =>
        void fragmentApi.update(manifest.id, {
          model: model ? { providerId: model.providerId, modelId: model.modelId } : null,
        })
      }
      nullLabel={t("fragments.modelFollowChat")}
      hideRotationOptions
      triggerClassName="h-7 text-xs"
      open={open}
      onOpenChange={onOpenChange}
      hideTrigger={open !== undefined}
    />
  )
}
