import type { LucideIcon } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * Botão toggle de modo (Pesquisa, Browser, Thinking, Plano) para a barra
 * inferior do input: cinza quando desligado, foreground + fundo quando ligado,
 * com tooltip explicativo.
 */
export function ModeToggle({
  icon: Icon,
  label,
  description,
  active,
  onToggle,
  disabled,
}: {
  icon: LucideIcon
  label: string
  description: string
  active: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={disabled}
              onClick={onToggle}
              className={cn(
                "flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors",
                active
                  ? "text-foreground bg-muted"
                  : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50",
                disabled && "opacity-40 cursor-not-allowed",
              )}
            />
          }
        >
          <Icon className="size-3.5" />
          <span>{label}</span>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" sideOffset={6}>
          {description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
