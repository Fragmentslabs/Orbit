import type { LucideIcon } from "lucide-react"
import { DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu"

interface ModeToggleDef {
  icon: LucideIcon
  label: string
  active: boolean
  onChange: (value: boolean) => void
}

export function ModeMenuItems({ items }: { items: ModeToggleDef[] }) {
  return (
    <>
      {items.map(({ icon: Icon, label, active, onChange }) => (
        <DropdownMenuCheckboxItem
          key={label}
          checked={active}
          onCheckedChange={(checked) => onChange(checked)}
        >
          <Icon className="size-4" />
          {label}
        </DropdownMenuCheckboxItem>
      ))}
    </>
  )
}

export type { ModeToggleDef }
