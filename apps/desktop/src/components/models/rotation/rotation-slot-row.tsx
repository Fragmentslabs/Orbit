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

// O card da linha JÁ é a borda visível — o trigger do picker vive dentro
// dele sem borda/fundo próprios, senão vira caixa-dentro-de-caixa (era o
// aninhamento que fazia a lista parecer desalinhada).
const SLOT_PICKER_TRIGGER_CLASS =
  "h-8 w-full justify-start gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-xs font-normal shadow-none hover:bg-accent/40"

/**
 * Linha de slot da rotação:
 *   - alça de drag (`GripVerticalIcon`)
 *   - número da posição (1..N)
 *   - `ModelPicker` controlado (sem grupo "Rotações" para não criar loop)
 *   - botão de remover slot
 *
 * O trigger do picker é o mesmo padrão do `preferences-panel`: logo do
 * provedor + nome do modelo. Não repetimos o nome do provedor ao lado — o
 * logo já comunica isso.
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

  // O valor é "completo" só quando ambos os ids estão presentes (um slot
  // vazio recém-criado tem providerId/modelId vazios e precisa aparecer
  // como "Nenhum" no trigger, não como modelo em branco).
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
      <button
        ref={setDragRef}
        {...attributes}
        {...listeners}
        type="button"
        title={t("rotation.dragSlot")}
        aria-label={t("rotation.dragSlot")}
        className="cursor-grab rounded-sm p-0.5 text-muted-foreground hover:text-foreground active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
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
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title={t("rotation.removeSlot")}
        aria-label={t("rotation.removeSlot")}
        onClick={onRemove}
        className="shrink-0 text-muted-foreground hover:text-destructive"
      >
        <XIcon />
      </Button>
    </div>
  )
}

export { MAX_ROTATION_SLOTS }

/**
 * Exportado para que o `useProviderStore` continue importável daqui se um
 * dia quisermos mover a regra "logo + nome" para um componente dedicado.
 * Mantém o `model-selector` como única fonte de verdade.
 */
export { ModelSelectorLogo, ModelSelectorName }
