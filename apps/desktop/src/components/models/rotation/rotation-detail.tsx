import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { PlusIcon, TrashIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useModelRotationStore, MAX_ROTATION_SLOTS } from "@/src/stores/model-rotation-store"
import type { ModelRotation, RotationModel } from "@shared/chat"
import type { SelectedModel } from "@/src/stores/provider-store"
import { useRotationDragSort } from "./use-rotation-drag-sort"
import { RotationSlotRow } from "./rotation-slot-row"

/**
 * Painel de detalhe de uma rotação (lado direito do split-view).
 * - Nome editável: estado local, sincroniza no `onBlur` ou Enter (não a cada
 *   keystroke) para evitar persistência + IPC a cada caractere.
 * - Validação inline de duplicata contra as outras rotações.
 * - Lista de modelos com DnD e botão de adicionar até `MAX_ROTATION_SLOTS`.
 * - Botão de excluir abre o `ConfirmDialog` do shadcn (em vez de window.confirm).
 *
 * Não há botão de "voltar": a lista fica sempre visível na coluna da
 * esquerda, então trocar de rotação é um clique nela.
 */
export function RotationDetail({
  rotation,
  onRequestRemove,
}: {
  rotation: ModelRotation
  onRequestRemove: () => void
}) {
  const { t } = useTranslation()
  const rotations = useModelRotationStore((s) => s.rotations)
  const rename = useModelRotationStore((s) => s.rename)
  const updateModels = useModelRotationStore((s) => s.updateModels)

  const [name, setName] = useState(rotation.name)
  const [nameError, setNameError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  // Reflete mudanças vindas de fora (ex.: renomeado por outro caminho)
  // SEM mexer no estado local enquanto o usuário está digitando.
  useEffect(() => {
    if (!editing) setName(rotation.name)
  }, [rotation.name, editing])

  const commitName = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError(t("rotation.nameRequired"))
      setName(rotation.name)
      setEditing(false)
      return
    }
    const duplicate = rotations.some(
      (r) => r.id !== rotation.id && r.name.trim().toLowerCase() === trimmed.toLowerCase(),
    )
    if (duplicate) {
      setNameError(t("rotation.nameDuplicate"))
      setName(rotation.name)
      setEditing(false)
      return
    }
    if (trimmed !== rotation.name) {
      rename(rotation.id, trimmed)
    }
    setNameError(null)
    setEditing(false)
  }

  const setSlot = (i: number, model: SelectedModel | null) => {
    const next = [...rotation.models]
    if (model) next[i] = { providerId: model.providerId, modelId: model.modelId }
    else next.splice(i, 1)
    updateModels(rotation.id, next)
  }

  const addSlot = () => {
    if (rotation.models.length >= MAX_ROTATION_SLOTS) return
    const empty: RotationModel = { providerId: "", modelId: "" }
    updateModels(rotation.id, [...rotation.models, empty])
  }

  const onReorder = (from: number, to: number) => {
    const next = [...rotation.models]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    updateModels(rotation.id, next)
  }

  const { DndContext, contextProps } = useRotationDragSort(rotation.models.length, onReorder)

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* O input do nome e os cards de modelo compartilham exatamente a
          mesma caixa (mesma borda esquerda e direita) — nada divide espaço
          horizontal com o input. */}
      <div>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setEditing(true)
            if (nameError) setNameError(null)
          }}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              e.currentTarget.blur()
            } else if (e.key === "Escape") {
              setName(rotation.name)
              setNameError(null)
              setEditing(false)
              e.currentTarget.blur()
            }
          }}
          className={cn(
            "h-9 text-sm font-medium",
            nameError && "border-destructive focus-visible:ring-destructive",
          )}
          placeholder={t("rotation.namePlaceholder")}
          aria-invalid={nameError ? true : undefined}
        />
        {nameError && (
          <p className="mt-1.5 text-[10px] text-destructive" role="alert">
            {nameError}
          </p>
        )}
        <div className="mt-2 flex items-center justify-between px-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("rotation.modelsSection")}
          </span>
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {rotation.models.length}/{MAX_ROTATION_SLOTS}
          </span>
        </div>
      </div>

      {/* Slots + "adicionar" formam uma pilha única de largura total: todos
          os itens têm a mesma altura de linha (h-10) e as mesmas bordas do
          input acima. */}
      <div className="-mt-1 min-h-0 flex-1 overflow-y-auto">
        <DndContext {...contextProps}>
          <div className="space-y-1.5">
            {rotation.models.map((model, index) => (
              <RotationSlotRow
                key={`${rotation.id}-${index}`}
                index={index}
                model={model}
                onChange={(m) => setSlot(index, m)}
                onRemove={() => setSlot(index, null)}
              />
            ))}
          </div>
        </DndContext>

        {rotation.models.length < MAX_ROTATION_SLOTS && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1.5 h-10 w-full justify-center gap-1.5 rounded-md border border-dashed border-input text-xs text-muted-foreground hover:text-foreground"
            onClick={addSlot}
          >
            <PlusIcon className="size-3.5" />
            {t("rotation.addModel")}
          </Button>
        )}
      </div>

      <div className="mt-auto border-t pt-3">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 h-7 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
          onClick={onRequestRemove}
        >
          <TrashIcon className="size-3.5" />
          {t("rotation.removeRotation")}
        </Button>
      </div>
    </div>
  )
}
