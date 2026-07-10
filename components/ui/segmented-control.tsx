import { cn } from "@/lib/utils"

/**
 * SegmentedControl — 3 estados mutuamente exclusivos. Usado nos ajustes de
 * thresholds de permissões (low / medium / high). Implementação leve em torno
 * de <button> + variantes tailwind; sem dependência de cva/buttonVariants
 * para manter o visual contido.
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
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div className={cn("inline-flex rounded-md border bg-muted/40 p-0.5", className)}>
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.hint}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex-1 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
