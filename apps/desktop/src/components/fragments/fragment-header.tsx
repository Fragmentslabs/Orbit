import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft } from "lucide-react"
import { Hint } from "@/components/ui/hint"
import { useFragment } from "@/src/components/fragment-tab"
import { fragmentApi } from "@/src/lib/ipc"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { FragmentIcon } from "./fragment-icon"
import { FragmentIconPicker } from "./fragment-icon-picker"
import { EditableName } from "@/src/components/editable-name"

/**
 * What the app header shows while a fragment is open: back arrow, the fragment's icon
 * (click to change it) and its name (click to rename). Everything the fragment itself offers —
 * its actions, its model and the widgets on the board — lives in the details panel, not here.
 * The screen below carries no header of its own — the fragment gets the whole area.
 */
export function FragmentHeaderTitle({ fragmentId }: { fragmentId: string }) {
  const { t } = useTranslation()
  const { manifest } = useFragment(fragmentId)
  const leave = useFragmentsStore((s) => s.leave)
  const [pickingIcon, setPickingIcon] = useState(false)

  if (!manifest) return null

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Hint label={t("fragments.back")}>
        <button
          type="button"
          onClick={leave}
          aria-label={t("fragments.back")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
      </Hint>
      <Hint label={t("fragments.changeIcon")}>
        <button
          type="button"
          onClick={() => setPickingIcon(true)}
          aria-label={t("fragments.changeIcon")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors hover:bg-primary/20"
        >
          <FragmentIcon name={manifest.icon} className="size-4" />
        </button>
      </Hint>
      <EditableName value={manifest.name} label={t("fragments.rename")} onSave={(next) => void fragmentApi.update(fragmentId, { name: next })} />
      <FragmentIconPicker open={pickingIcon} onOpenChange={setPickingIcon} fragmentId={manifest.id} current={manifest.icon} />
    </div>
  )
}
