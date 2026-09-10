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
 * Modal de rotação de modelos.
 *
 * Layout split-view animado:
 *   - Lista à esquerda (260px) sempre visível quando o modal está aberto.
 *   - Quando uma rotação é selecionada, a lista desliza para fora e o
 *     `RotationDetail` entra com `slide-in-from-right-6`.
 *   - A volta (botão de "voltar" no detalhe) desfaz a transição.
 *
 * O id selecionado é decidido SÓ NA ABERTURA: o store de UI entrega um
 * `rotationId` (opcional). Se ele apontar para uma rotação válida, abrimos
 * direto no detalhe. Caso contrário (ou quando o usuário clica "Criar
 * rotação"), a lista é exibida em estado neutro. A `wasOpen` ref impede
 * que mudanças posteriores roubem a seleção (mesmo padrão do modal anterior).
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
    // Split fixo: o painel da direita nunca fica vazio quando existe ao
    // menos uma rotação — abre na rotação pedida ou na primeira da lista.
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
    // Ao excluir a rotação aberta, seleciona a vizinha em vez de deixar o
    // painel vazio (só cai para `null` quando não sobra nenhuma).
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
            // Largura maior para acomodar o split-view sem ficar espremido.
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

          {/* Split fixo: a lista vive sempre à esquerda e o detalhe à
              direita. Sem colapso/slide — trocar de rotação é um clique e o
              painel da direita só fica vazio quando não existe rotação
              alguma. */}
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

/** Host único montado na raiz do app (mesmo padrão do SettingsDialogHost). */
export function RotationDialogHost() {
  return <RotationDialog />
}

export { MAX_ROTATION_SLOTS }
