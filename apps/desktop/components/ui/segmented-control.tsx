import { cn } from "@/lib/utils"

import { Hint } from "@/components/ui/hint"
/**
 * SegmentedControl — 3 mutually exclusive states. Used in the settings of
 * permission thresholds (low / medium / high). Lightweight implementation around
 * <button> + tailwind variants; without a dependency on cva/buttonVariants
 * to keep the visuals contained.
 */

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  hint?: string
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  className?: string
  size?: "xs" | "sm" | "default"
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
  size = "default",
}: SegmentedControlProps<T>) {
  return (
    <div className={cn("inline-flex rounded-md border bg-muted/40 p-0.5", className)}>
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <Hint key={opt.value} label={opt.hint ?? ""}>
            <button
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                "flex-1 rounded-[5px] font-medium transition-colors",
                size === "xs" ? "px-1 py-px text-[9px] leading-tight"
                : size === "sm" ? "px-1.5 py-0.5 text-[10px]"
                : "px-2.5 py-1 text-xs",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          </Hint>
        )
      })}
    </div>
  )
}
