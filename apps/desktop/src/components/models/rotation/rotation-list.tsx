import { useTranslation } from "react-i18next"
import { ListRestartIcon, PlusIcon, TrashIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ModelRotation } from "@shared/chat"

/**
 * Lista de rotações (coluna esquerda do split-view). Cada linha é um botão
 * inteiro — sem ações inline na linha (sem trash na lista): as ações vivem
 * no painel de detalhe. Isso evita acionar o menu errado por engano e
 * mantém a lista densa.
 */
export function RotationList({
  rotations,
  selectedId,
  onSelect,
  onCreate,
  onRequestRemove,
}: {
  rotations: ModelRotation[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onRequestRemove: (rotation: ModelRotation) => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <Button
        variant="outline"
        size="sm"
        className="h-9 w-full gap-1.5 border-dashed text-xs"
        onClick={onCreate}
      >
        <PlusIcon className="size-3.5" />
        {t("rotation.new")}
      </Button>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {rotations.map((rotation) => {
          const isActive = rotation.id === selectedId
          return (
            <div
              key={rotation.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(rotation.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onSelect(rotation.id)
                }
              }}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "group flex h-10 cursor-pointer items-center gap-2 rounded-md border px-2 text-left transition-colors hover:bg-accent/40",
                isActive
                  ? "border-primary/60 bg-primary/5"
                  : "border-transparent",
              )}
            >
              <ListRestartIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs font-medium text-foreground">{rotation.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {t("rotation.slotsLabel", { count: rotation.models.length })}
                </span>
              </span>
              <button
                type="button"
                title={t("rotation.remove")}
                aria-label={t("rotation.remove")}
                onClick={(e) => {
                  e.stopPropagation()
                  onRequestRemove(rotation)
                }}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              >
                <TrashIcon className="size-3" />
              </button>
            </div>
          )
        })}

        {rotations.length === 0 && (
          <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
            {t("rotation.empty")}
          </p>
        )}
      </div>
    </div>
  )
}
