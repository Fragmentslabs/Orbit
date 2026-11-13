import { Brain, Settings2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { ModelVariant } from "@shared/chat"

/**
 * Thinking level dropdown (opens upwards). Always visible when the
 * model exposes variants (thinking is always active in models with reasoning;
 * the level is the only choice). Models that allow turning it off (`canDisable`)
 * get the "Off" option — through `onSelect(null)`.
 */
export function ReasoningPicker({
  variants,
  enabled,
  canDisable,
  selected,
  onSelect,
  className,
  compact,
}: {
  variants: ModelVariant[]
  enabled: boolean
  /** Whether the model allows turning thinking off (false for reasoningAlwaysOn) */
  canDisable?: boolean
  selected: string | undefined
  onSelect: (variantId: string | null) => void
  className?: string
  /**
   * Narrow container: the trigger loses the label and becomes an icon button
   * (the level stays one click away, in the same place). It is the middle step
   * between the full selector and the single "everything" button of the footer,
   * so it looks exactly like that button: same Settings2 icon, same muted color,
   * same size. When the model is absorbed, the button keeps its identity.
   */
  compact?: boolean
}) {
  const { t } = useTranslation()
  if (variants.length === 0) return null

  const value = canDisable && !enabled ? "off" : (selected ?? null)
  const variantLabel = (id: string) =>
    id === "off"
      ? t("reasoning.off")
      : t(`reasoning.variants.${id}`, { defaultValue: variants.find((v) => v.id === id)?.label ?? id })

  if (compact) {
    const title = value == null ? t("reasoning.placeholder") : variantLabel(value)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={title}
          title={title}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
            className,
          )}
        >
          <Settings2 className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" sideOffset={4} align="start" className="min-w-40 p-1">
          <DropdownMenuRadioGroup
            value={value ?? ""}
            onValueChange={(next) => {
              if (!next) return
              onSelect(next === "off" ? null : next)
            }}
          >
            {canDisable && <DropdownMenuRadioItem value="off">{t("reasoning.off")}</DropdownMenuRadioItem>}
            {variants.map((variant) => (
              <DropdownMenuRadioItem key={variant.id} value={variant.id}>
                {variantLabel(variant.id)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (!next) return
        if (next === "off") {
          onSelect(null)
          return
        }
        onSelect(next as string)
      }}
    >
      <SelectTrigger
        size="sm"
        className={cn(
          "h-7 gap-1 border-none bg-transparent px-1.5 text-xs hover:bg-muted dark:bg-transparent dark:hover:bg-muted",
          className,
        )}
      >
        <Brain className="size-3 text-foreground" />
        <SelectValue placeholder={t("reasoning.placeholder")}>
          {(shown) => {
            // Base UI renders the raw value in the trigger; here we format it with the translated label
            if (shown == null) return t("reasoning.placeholder")
            return variantLabel(String(shown))
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent side="top" sideOffset={4} align="start" alignItemWithTrigger={false}>
        {canDisable && <SelectItem value="off">{t("reasoning.off")}</SelectItem>}
        {variants.map((variant) => (
          <SelectItem key={variant.id} value={variant.id}>
            {t(`reasoning.variants.${variant.id}`, { defaultValue: variant.label })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
