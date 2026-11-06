import { MoreHorizontal } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export interface CardMenuItem {
  id: string
  label: string
  icon?: React.ComponentType<{ className?: string }>
  onSelect: () => void
  /** Shown in red, after a separator (remove). */
  destructive?: boolean
  /** A toggle: the item carries a check while it is on. */
  checked?: boolean
  disabled?: boolean
}

/**
 * The single action button of the cards of the Tools sections (MCP, Skills, Hooks): an
 * ellipsis that opens everything else you can do with the item. What the user needs to
 * see at a glance (status, switch, authorize) stays on the card itself, as badges or
 * controls of their own.
 */
export function CardMenu({ items, label }: { items: CardMenuItem[]; label?: string }) {
  const { t } = useTranslation()
  const regular = items.filter((i) => !i.destructive)
  const destructive = items.filter((i) => i.destructive)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="icon-sm" variant="ghost" aria-label={label ?? t("header.options")} className="shrink-0 text-muted-foreground" />
        }
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {regular.map((item) =>
          item.checked !== undefined ? (
            <DropdownMenuCheckboxItem key={item.id} checked={item.checked} disabled={item.disabled} onCheckedChange={() => item.onSelect()}>
              {item.label}
            </DropdownMenuCheckboxItem>
          ) : (
            <DropdownMenuItem key={item.id} disabled={item.disabled} onClick={item.onSelect}>
              {item.icon && <item.icon className="size-4" />}
              {item.label}
            </DropdownMenuItem>
          ),
        )}
        {regular.length > 0 && destructive.length > 0 && <DropdownMenuSeparator />}
        {destructive.map((item) => (
          <DropdownMenuItem key={item.id} variant="destructive" disabled={item.disabled} onClick={item.onSelect}>
            {item.icon && <item.icon className="size-4" />}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
