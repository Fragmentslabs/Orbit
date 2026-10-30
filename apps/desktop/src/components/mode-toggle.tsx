import type { LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * Mode toggle button (Research, Browser, Plan, Memory, …) for the bottom bar
 * of the input: gray when off, foreground + background when on,
 * with an explanatory tooltip.
 *
 * `iconOnly` removes the label ("Icon only" setting). Even with
 * `iconOnly={false}`, the label only appears in wide containers (`@lg` — the
 * input wrapper has `@container`): on narrow screens/containers the icon-only
 * mode is forced so the row never overflows.
 *
 * `onConfig` (modes that have settings) opens the mode modal with the RIGHT
 * button — the left one keeps only turning on/off.
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
  /** Opens the mode settings (right click) */
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
