import type { LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * Botão toggle de modo (Pesquisa, Browser, Plano, Memória, …) para a barra
 * inferior do input: cinza quando desligado, foreground + fundo quando ligado,
 * com tooltip explicativo.
 *
 * `iconOnly` remove o label (configuração "Só ícone"). Mesmo com
 * `iconOnly={false}`, o label só aparece em containers largos (`@lg` — o
 * wrapper do input tem `@container`): em telas/containers estreitos o modo
 * icon-only é forçado para a fileira nunca estourar.
 *
 * `onConfig` (modos que têm configuração) abre o modal do modo com o botão
 * DIREITO — o esquerdo continua só ligando/desligando.
 */
export function ModeToggle({
  icon: Icon,
  label,
  description,
  active,
  onToggle,
  onConfig,
  disabled,
  iconOnly,
}: {
  icon: LucideIcon
  label: string
  description: string
  active: boolean
  onToggle: () => void
  /** Abre a configuração do modo (clique direito) */
  onConfig?: () => void
  disabled?: boolean
  iconOnly?: boolean
}) {
  const { t } = useTranslation()
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={disabled}
              onClick={onToggle}
              onContextMenu={
                onConfig
                  ? (e) => {
                      e.preventDefault()
                      onConfig()
                    }
                  : undefined
              }
              aria-label={iconOnly ? label : undefined}
              className={cn(
                "flex items-center rounded-md text-xs transition-colors",
                iconOnly ? "size-7 justify-center px-0" : "gap-1 px-1.5 py-1",
                active
                  ? "text-foreground bg-muted"
                  : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50",
                disabled && "opacity-40 cursor-not-allowed",
              )}
            />
          }
        >
          <Icon className="size-3.5" />
          {!iconOnly && (
            <span className="hidden @xl:inline shrink-0 whitespace-nowrap">{label}</span>
          )}
        </TooltipTrigger>
        <TooltipContent side="top" align="center" sideOffset={6}>
          {description}
          {onConfig && (
            <span className="mt-1 block opacity-70">{t("input.modes.configureHint")}</span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
