import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface FilterOption<T extends string> {
  value: T
  label: string
  icon: LucideIcon
  count: number
}

/**
 * The right-hand filter rail of a library page: a total, one row per source and a line
 * explaining what the active one leaves in. Used by the fragments gallery and by the
 * Widgets tab, so the two never drift into different shapes.
 */
export function FilterRail<T extends string>({
  title,
  count,
  countLabel,
  options,
  value,
  onChange,
  hint,
  className,
}: {
  title: string
  count: number
  countLabel: string
  options: readonly FilterOption<T>[]
  value: T
  onChange: (value: T) => void
  hint?: string
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div>
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
        <p className="mt-1 text-2xl font-semibold leading-none tabular-nums">{count}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{countLabel}</p>
      </div>
      <div className="flex flex-col gap-0.5">
        {options.map((option) => {
          const Icon = option.icon
          const active = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              aria-pressed={active}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Icon className={cn("size-3.5 shrink-0", active && "text-primary")} />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <span className={cn("shrink-0 text-[10px] tabular-nums", !active && "text-muted-foreground")}>
                {option.count}
              </span>
            </button>
          )
        })}
      </div>
      {hint && <p className="text-[10px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * The same filters when the page is too narrow for the rail: one row of chips above the
 * grid. A page that collapses keeps the same labels and counts — only the shape changes.
 */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: readonly FilterOption<T>[]
  value: T
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <div className={cn("flex gap-1 overflow-x-auto pb-2", className)}>
      {options.map((option) => {
        const Icon = option.icon
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
              active
                ? "border-primary/60 bg-primary/15 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className={cn("size-3", active && "text-primary")} />
            {option.label}
            <span className="tabular-nums text-muted-foreground">{option.count}</span>
          </button>
        )
      })}
    </div>
  )
}
