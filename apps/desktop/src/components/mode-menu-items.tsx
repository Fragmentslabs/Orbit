import type { LucideIcon } from "lucide-react"
import { Settings2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

interface ModeToggleDef {
  icon: LucideIcon
  label: string
  active: boolean
  onChange: (value: boolean) => void
  /** Abre a configuração do modo (gear no item) — sem alternar o toggle */
  onConfig?: () => void
}

function Gear({ onClick, active }: { onClick: () => void; active: boolean }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className={cn(
        "absolute top-1/2 -translate-y-1/2 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        active ? "right-8" : "right-2",
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClick()
      }}
    >
      <Settings2 className="!size-3.5" />
      <span className="sr-only">{t("delegation.configure")}</span>
    </button>
  )
}

export function ModeMenuItems({ items }: { items: ModeToggleDef[] }) {
  return (
    <>
      {items.map(({ icon: Icon, label, active, onChange, onConfig }) => (
        <DropdownMenuCheckboxItem
          key={label}
          checked={active}
          onCheckedChange={(checked) => onChange(checked)}
          className={cn(onConfig && (active ? "pr-14" : "pr-9"))}
        >
          <Icon className="size-4" />
          {label}
          {onConfig && <Gear onClick={onConfig} active={active} />}
        </DropdownMenuCheckboxItem>
      ))}
    </>
  )
}

export type { ModeToggleDef }
