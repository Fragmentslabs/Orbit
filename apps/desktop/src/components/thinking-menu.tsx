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
 * Nível de raciocínio de um modelo das Preferências: botão só com ícone, ao
 * lado do seletor, que abre os níveis que o modelo oferece. Desabilitado
 * quando o modelo não pensa (ou nenhum está escolhido).
 */
export function ThinkingMenu({
  model: selected,
  value,
  onChange,
}: {
  model: DefaultModel | null
  value: ReasoningConfig | null
  /** null = raciocínio desligado */
  onChange: (next: ReasoningConfig | null) => void
}) {
  const { t } = useTranslation()
  const model = useProviderStore((s) => (selected ? s.catalog[selected.providerId]?.models[selected.modelId] : undefined))

  const variants = model?.variants ?? []
  // Modelo que pensa mas não tem níveis: só liga/desliga.
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
          {/* Dentro do grupo: no Base UI o rótulo fora de um Menu.Group derruba a tela ao abrir. */}
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
 * Nível guardado POR MODELO — o mesmo que o seletor de raciocínio do chat lê e
 * grava. Escolher aqui o nível do modelo padrão faz o chat novo já começar nele.
 */
export function ModelThinkingMenu({ model }: { model: DefaultModel | null }) {
  const { enabled, variantId, update } = useReasoningPrefs(model?.providerId, model?.modelId)
  return (
    <ThinkingMenu
      model={model}
      value={enabled ? { enabled, variantId } : null}
      // Desligar guarda o nível: religar pelo chat volta ao que estava.
      onChange={(next) => update(next ? { enabled: true, variantId: next.variantId } : { enabled: false, variantId })}
    />
  )
}
