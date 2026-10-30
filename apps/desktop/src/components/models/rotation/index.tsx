import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ListRestartIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import { useModelRotationStore, MAX_ROTATION_SLOTS } from "@/src/stores/model-rotation-store"
import { useRotationUi } from "@/src/stores/rotation-ui"
import type { ModelRotation } from "@shared/chat"

import { RotationList } from "./rotation-list"
import { RotationDetail } from "./rotation-detail"

/**
 * Model rotation modal.
 *
 * Animated split-view layout:
 *   - List on the left (260px) always visible when the modal is open.
 *   - When a rotation is selected, the list slides out and
 *     `RotationDetail` enters with `slide-in-from-right-6`.
 *   - Going back (the "back" button in the detail) undoes the transition.
 *
 * The selected id is decided ONLY ON OPENING: the UI store delivers a
 * `rotationId` (optional). If it points to a valid rotation, we open
 * straight in the detail. Otherwise (or when the user clicks "Create
 * rotation"), the list is shown in a neutral state. The `wasOpen` ref prevents
 * later changes from stealing the selection (same pattern as the previous modal).
 */
export function RotationDialog() {
  const { t } = useTranslation()
  const open = useRotationUi((s) => s.open)
  const setOpen = useRotationUi((s) => s.setOpen)
  const requestRotationId = useRotationUi((s) => s.rotationId)

  const rotations = useModelRotationStore((s) => s.rotations)
  const create = useModelRotationStore((s) => s.create)
  const remove = useModelRotationStore((s) => s.remove)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<ModelRotation | null>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      setSelectedId(null)
      setConfirmRemove(null)
      return
    }
    if (wasOpen.current) return
    wasOpen.current = true
    // Fixed split: the right panel is never empty when there is at
    // least one rotation — it opens on the requested rotation or on the first of the list.
    if (requestRotationId && rotations.some((r) => r.id === requestRotationId)) {
      setSelectedId(requestRotationId)
    } else {
      setSelectedId(rotations[0]?.id ?? null)
    }
  }, [open, requestRotationId, rotations])

  const handleCreate = () => {
    const rotation = create(t("rotation.newName"))
    setSelectedId(rotation.id)
  }

  const handleRequestRemove = (rotation: ModelRotation) => setConfirmRemove(rotation)

  const handleConfirmRemove = () => {
    if (!confirmRemove) return
    const id = confirmRemove.id
    // On deleting the open rotation, it selects the neighbor instead of leaving the
    // panel empty (it only falls to `null` when none is left).
    const nextId =
      selectedId === id
        ? rotations.filter((r) => r.id !== id)[0]?.id ?? null
        : selectedId
    remove(id)
    setSelectedId(nextId)
    setConfirmRemove(null)
  }

  const selected = selectedId ? rotations.find((r) => r.id === selectedId) ?? null : null

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className={cn(
            // Larger width to accommodate the split view without getting squeezed.
            "max-w-xl overflow-hidden p-0",
          )}
        >
          <DialogHeader className="space-y-1 border-b px-4 py-3">
            <DialogTitle className="flex items-center gap-2 text-sm">
              <ListRestartIcon className="size-4 text-muted-foreground" />
              {t("rotation.title")}
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              {t("rotation.description")}
            </DialogDescription>
          </DialogHeader>

          {/* Fixed split: the list always lives on the left and the detail on the
              right. No collapse/slide — switching rotation is one click and the
              right panel only stays empty when there is no rotation at
              all. */}
          <div className="grid h-[380px] sm:grid-cols-[220px_minmax(0,1fr)]">
            <div className="min-h-0 border-r p-3">
              <RotationList
                rotations={rotations}
                selectedId={selectedId}
                onSelect={(id) => setSelectedId(id)}
                onCreate={handleCreate}
                onRequestRemove={handleRequestRemove}
              />
            </div>

            <div className="min-h-0 p-4">
              {selected ? (
                <RotationDetail
                  key={selected.id}
                  rotation={selected}
                  onRequestRemove={() => handleRequestRemove(selected)}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
                  <ListRestartIcon className="size-5 text-muted-foreground/50" />
                  <p className="max-w-[280px] text-xs leading-relaxed text-muted-foreground">
                    {t("rotation.emptyHint")}
                  </p>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmRemove}
        onOpenChange={(o) => !o && setConfirmRemove(null)}
        title={t("rotation.confirmRemove", { name: confirmRemove?.name ?? "" })}
        description={t("rotation.confirmRemoveDescription")}
        confirmLabel={t("rotation.remove")}
        cancelLabel={t("rotation.cancel")}
        destructive
        onConfirm={handleConfirmRemove}
      />
    </>
  )
}

/** Single host mounted at the root of the app (same pattern as SettingsDialogHost). */
export function RotationDialogHost() {
  return <RotationDialog />
}

export { MAX_ROTATION_SLOTS }
