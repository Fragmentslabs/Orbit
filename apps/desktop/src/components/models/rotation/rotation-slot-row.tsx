import { useDraggable, useDroppable } from "@dnd-kit/core"
import { useTranslation } from "react-i18next"
import { GripVerticalIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ModelPicker } from "@/src/components/model-picker"
import { ModelSelectorLogo, ModelSelectorName } from "@/src/components/ai/model-selector"
import type { SelectedModel } from "@/src/stores/provider-store"
import type { RotationModel } from "@shared/chat"
import { MAX_ROTATION_SLOTS } from "@/src/stores/model-rotation-store"
import { dropId, dragId } from "./use-rotation-drag-sort"
import { Hint } from "@/components/ui/hint"

// The row card ALREADY is the visible border — the picker trigger lives inside
// it without its own border/background, otherwise it becomes a box-inside-a-box (it was the
// nesting that made the list look misaligned).
const SLOT_PICKER_TRIGGER_CLASS =
  "h-8 w-full justify-start gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-xs font-normal shadow-none hover:bg-accent/40"

/**
 * Rotation slot row:
 *   - drag handle (`GripVerticalIcon`)
 *   - position number (1..N)
 *   - controlled `ModelPicker` (no "Rotations" group so as not to create a loop)
 *   - remove slot button
 *
 * The picker trigger is the same pattern as the `preferences-panel`: provider
 * logo + model name. We do not repeat the provider name next to it — the
 * logo already communicates that.
 */
export function RotationSlotRow({
  index,
  model,
  onChange,
  onRemove,
}: {
  index: number
  model: RotationModel
  onChange: (model: SelectedModel | null) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: dragId(index),
  })
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: dropId(index) })

  // The value is "complete" only when both ids are present (an empty
  // slot just created has empty providerId/modelId and needs to appear
  // as "None" in the trigger, not as a blank model).
  const value: SelectedModel | null =
    model.providerId && model.modelId ? { providerId: model.providerId, modelId: model.modelId } : null

  return (
    <div
      ref={setDropRef}
      className={cn(
        "flex h-10 items-center gap-1 rounded-md border bg-card pl-1.5 pr-1 transition-colors",
        isDragging && "opacity-40",
        isOver && "border-primary",
      )}
    >
      <Hint label={t("rotation.dragSlot")}>
        <button
          ref={setDragRef}
          {...attributes}
          {...listeners}
          type="button"
          aria-label={t("rotation.dragSlot")}
          className="cursor-grab rounded-sm p-0.5 text-muted-foreground hover:text-foreground active:cursor-grabbing"
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
      </Hint>
      <span className="w-4 shrink-0 text-center text-[10px] font-medium tabular-nums text-muted-foreground">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <ModelPicker
          triggerClassName={SLOT_PICKER_TRIGGER_CLASS}
          value={value}
          onValueChange={onChange}
          nullLabel={t("rotation.slotNone")}
          hideRotationOptions
        />
      </div>
      <Hint label={t("rotation.removeSlot")}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"

          aria-label={t("rotation.removeSlot")}
          onClick={onRemove}
          className="shrink-0 text-muted-foreground hover:text-destructive"
        >
          <XIcon />
        </Button>
      </Hint>
    </div>
  )
}

export { MAX_ROTATION_SLOTS }

/**
 * Exported so that `useProviderStore` stays importable from here if one
 * day we want to move the "logo + name" rule to a dedicated component.
 * It keeps the `model-selector` as the single source of truth.
 */
export { ModelSelectorLogo, ModelSelectorName }
