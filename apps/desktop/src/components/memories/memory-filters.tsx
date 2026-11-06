import { cn } from "@/lib/utils"

/**
 * Filter menu on the right of the Memories page — same shape as the section menu of
 * the Tools page: groups separated by a line, each option with its count.
 */

export interface FilterOption {
  value: string
  label: string
  count: number
  /** Color dot before the label (the kind colors, same as the card strip). */
  color?: string
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
      {option.color && (
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: option.color }}
          aria-hidden
        />
      )}
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      <span className="text-[11px] font-normal tabular-nums text-muted-foreground">{option.count}</span>
    </button>
  )
}

export function MemoryFilters({ groups, label, inline }: { groups: FilterGroup[]; label: string; /** Inside a popover (narrow page): no column of its own. */ inline?: boolean }) {
  return (
    <nav
      aria-label={label}
      className={cn("flex flex-col gap-0.5 overflow-y-auto", inline ? "max-h-[70vh] w-60" : "w-52 shrink-0 border-l pl-3")}
    >
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
