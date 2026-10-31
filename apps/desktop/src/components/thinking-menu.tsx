import { useTranslation } from "react-i18next"
import { Settings2 } from "lucide-react"
import type { ReasoningConfig } from "@shared/chat"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useReasoningPrefs } from "@/src/stores/reasoning-prefs"
import { useProviderStore } from "@/src/stores/provider-store"
import type { DefaultModel } from "@/src/stores/model-mode-prefs"

/**
 * Reasoning level of a Preferences model: icon-only button, next
 * to the selector, which opens the levels the model offers. Disabled
 * when the model does not think (or none is chosen).
 */
export function ThinkingMenu({
  model: selected,
  value,
  onChange,
}: {
  model: DefaultModel | null
  value: ReasoningConfig | null
  /** null = reasoning off */
  onChange: (next: ReasoningConfig | null) => void
}) {
  const { t } = useTranslation()
  const model = useProviderStore((s) => (selected ? s.catalog[selected.providerId]?.models[selected.modelId] : undefined))

  const variants = model?.variants ?? []
  // A model that thinks but has no levels: it only turns on/off.
  const options = variants.length > 0 ? variants.map((v) => v.id) : ["on"]
  const current = value?.enabled ? (value.variantId ?? "on") : "off"
  const disabled = !model?.reasoning

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={t("preferences.thinkingLevel")}
        title={!selected ? t("preferences.thinkingNoModel") : disabled ? t("preferences.thinkingUnavailable") : t("preferences.thinkingLevel")}
        className="flex size-7 items-center justify-center rounded-md border border-input text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 aria-expanded:bg-muted"
      >
        <Settings2 className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44 p-1">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(next) => {
            if (!next) return
            onChange(next === "off" ? null : { enabled: true, variantId: next === "on" ? undefined : String(next) })
          }}
        >
          {/* Inside the group: in Base UI the label outside a Menu.Group takes the screen down on opening. */}
          <DropdownMenuLabel className="text-xs text-muted-foreground">{t("preferences.thinkingLevel")}</DropdownMenuLabel>
          {!model?.reasoningAlwaysOn && (
            <DropdownMenuRadioItem value="off">{t("reasoning.off")}</DropdownMenuRadioItem>
          )}
          {options.map((id) => (
            <DropdownMenuRadioItem key={id} value={id}>
              {id === "on"
                ? t("reasoning.variants.thinking")
                : t(`reasoning.variants.${id}`, { defaultValue: variants.find((v) => v.id === id)?.label ?? id })}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Level stored PER MODEL: the default a chat inherits when neither it nor the last
 * chat used has a choice of its own. The chat selector writes per session, so a level
 * chosen in a conversation never changes the others.
 */
export function ModelThinkingMenu({ model }: { model: DefaultModel | null }) {
  const { enabled, variantId, update } = useReasoningPrefs(model?.providerId, model?.modelId)
  return (
    <ThinkingMenu
      model={model}
      value={enabled ? { enabled, variantId } : null}
      // Turning it off keeps the level: turning it back on through the chat goes back to what it was.
      onChange={(next) => update(next ? { enabled: true, variantId: next.variantId } : { enabled: false, variantId })}
    />
  )
}
