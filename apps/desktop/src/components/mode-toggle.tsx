import type { LucideIcon } from "lucide-react"
import { Settings2 } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * Botão toggle de modo (Pesquisa, Browser, Thinking, Plano) para a barra
 * inferior do input: cinza quando desligado, foreground + fundo quando ligado,
 * com tooltip explicativo. Opcionalmente acompanha uma engrenagem (onConfig)
 * que abre a configuração do modo sem alterná-lo.
 */
export function ModeToggle({
  icon: Icon,
  label,
  description,
  active,
  onToggle,
  disabled,
  onConfig,
  configLabel,
}: {
  icon: LucideIcon
  label: string
  description: string
  active: boolean
  onToggle: () => void
  disabled?: boolean
  onConfig?: () => void
  configLabel?: string
}) {
  return (
    <TooltipProvider delay={300}>
      <div className="flex items-center gap-0.5">
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
        {onConfig && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onConfig}
                  className="flex size-4 items-center justify-center rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/50"
                />
              }
            >
              <Settings2 className="size-3" />
              <span className="sr-only">{configLabel ?? label}</span>
            </TooltipTrigger>
            <TooltipContent side="top" align="center" sideOffset={6}>
              {configLabel ?? label}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  )
}
