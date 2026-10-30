import { Brain } from "lucide-react"
import { useTranslation } from "react-i18next"
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
}: {
  variants: ModelVariant[]
  enabled: boolean
  /** Whether the model allows turning thinking off (false for reasoningAlwaysOn) */
  canDisable?: boolean
  selected: string | undefined
  onSelect: (variantId: string | null) => void
  className?: string
}) {
  const { t } = useTranslation()
  if (variants.length === 0) return null

  const value = canDisable && !enabled ? "off" : (selected ?? null)

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
          {(value) => {
            // Base UI renders the raw value in the trigger; here we format it with the translated label
            if (value == null) return t("reasoning.placeholder")
            if (value === "off") return t("reasoning.off")
            const variant = variants.find((v) => v.id === value)
            return variant
              ? t(`reasoning.variants.${variant.id}`, { defaultValue: variant.label })
              : String(value)
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
