import { Check } from "lucide-react"

import { cn } from "@/lib/utils"
import { scoreColor } from "./meta"

/** Componentes visuais compartilhados da aba Models. */

export function ScoreBar({ score, className, showValue = true }: {
  score?: number
  className?: string
  showValue?: boolean
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        {score !== undefined && (
          <div
            className={cn("h-full rounded-full transition-all", scoreColor(score))}
            style={{ width: `${score}%` }}
          />
        )}
      </div>
      {showValue && (
        <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
          {score !== undefined ? score : "—"}
        </span>
      )}
    </div>
  )
}

/** Checkbox simples (não há componente ui/checkbox no projeto). */
export function ModelCheckbox({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-transparent hover:border-primary/50",
      )}
    >
      {checked && <Check className="size-3" />}
    </button>
  )
}
