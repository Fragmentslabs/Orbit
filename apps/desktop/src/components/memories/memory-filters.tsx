import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/**
 * Filter menu on the right of the Memories page — same shape as the section menu of
 * the Tools page: groups separated by a line, each option with its count. The column
 * itself (width, border, scroll) belongs to the page, which puts the summary cards
 * above it.
 */

export interface FilterOption {
  value: string
  label: string
  count: number
  /** Color of the option (kind colors, same as the icons on the cards). */
  color?: string
  /** Icon before the label; wins over the plain dot when present. */
  icon?: LucideIcon
}

export interface FilterGroup {
  id: string
  label: string
  value: string
  options: FilterOption[]
  onChange: (value: string) => void
}

function FilterItem({ option, active, onClick }: {
  option: FilterOption
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      {option.icon ? (
        <option.icon className="size-3.5 shrink-0" style={{ color: option.color }} aria-hidden />
      ) : option.color ? (
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: option.color }}
          aria-hidden
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      <span className="text-[11px] font-normal tabular-nums text-muted-foreground">{option.count}</span>
    </button>
  )
}

export function MemoryFilters({ groups, label }: { groups: FilterGroup[]; label: string }) {
  return (
    <nav aria-label={label} className="flex flex-col gap-0.5">
      {groups.map((group, i) => (
        <div key={group.id} className="flex flex-col gap-0.5">
          {i > 0 && <div className="mx-2 my-2 h-px bg-border" role="separator" />}
          <p className="px-3 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground">{group.label}</p>
          {group.options.map((option) => (
            <FilterItem
              key={option.value}
              option={option}
              active={group.value === option.value}
              onClick={() => group.onChange(option.value)}
            />
          ))}
        </div>
      ))}
    </nav>
  )
}

/**
 * The same groups as three selects in a row, for when the page is narrow and the column of the right
 * does not fit: each one reads "Group: option" and lists the options with their counts.
 */
export function MemoryFilterSelects({ groups, label }: { groups: FilterGroup[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {groups.map((group) => {
        const current = group.options.find((o) => o.value === group.value)
        return (
          <Select key={group.id} value={group.value} onValueChange={(value) => group.onChange(value ?? group.value)}>
            <SelectTrigger className="h-8 min-w-32 flex-1 text-xs">
              <SelectValue>
                <span className="text-muted-foreground">{group.label}:</span> {current?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {group.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label} ({option.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      })}
    </div>
  )
}
