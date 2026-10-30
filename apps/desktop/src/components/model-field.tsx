import { useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { BrainIcon, ChevronDownIcon, SettingsIcon } from "lucide-react"
import type { CatalogModel, CatalogProvider } from "@shared/chat"
import { Button } from "@/components/ui/button"
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/src/components/ai/model-selector"
import { ModalityIcons } from "@/src/components/ai/modality-icons"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSettingsUi } from "@/src/stores/settings-ui"
import type { DefaultModel } from "@/src/stores/model-mode-prefs"

/** Model selector of Preferences (default model, sub-agents, auxiliary…). */
const MAX_MODELS_PER_PROVIDER = 40

export function ModelField({
  label,
  value,
  onChange,
  nullLabel,
  action,
  filter,
}: {
  label: string
  value: DefaultModel | null
  onChange: (v: DefaultModel | null) => void
  nullLabel?: string
  /** Extra control next to the selector (e.g. reasoning level) */
  action?: ReactNode
  /** Restricts the list (e.g. only vision models for the vision model) */
  filter?: (provider: CatalogProvider, model: CatalogModel) => boolean
}) {
  const [open, setOpen] = useState(false)
  const [skipFinalFocus, setSkipFinalFocus] = useState(false)
  const pendingSettings = useRef(false)
  const openSettings = useSettingsUi((s) => s.openSettings)
  const catalog = useProviderStore((s) => s.catalog)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)

  const groups = useMemo(
    () =>
      connectedProviders
        .filter((id) => catalog[id])
        .map((id) => ({
          provider: catalog[id],
          models: Object.values(catalog[id].models)
            // Filter before the cut: the ceiling of 40 counts for what is left, not
            // for the raw list (otherwise a vision filter could zero everything).
            .filter((model) => (filter ? filter(catalog[id], model) : true))
            .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""))
            .slice(0, MAX_MODELS_PER_PROVIDER),
        }))
        .filter((group) => group.models.length > 0),
    [catalog, connectedProviders, filter],
  )

  const selectedModel = value ? catalog[value.providerId]?.models[value.modelId] : undefined
  const { t } = useTranslation()

  return (
    <div>
      <p className="mb-1 text-xs font-medium">{label}</p>
      <div className="flex items-center gap-1">
      <ModelSelector
        open={open}
        onOpenChange={setOpen}
        onOpenChangeComplete={(isOpen) => {
          if (isOpen) return
          setSkipFinalFocus(false)
          if (!pendingSettings.current) return
          pendingSettings.current = false
          openSettings("providers")
        }}
      >
        <ModelSelectorTrigger render={<Button className="h-7 gap-1 px-1.5 text-xs" variant="outline" />}>
          {value ? (
            <>
              <ModelSelectorLogo provider={value.providerId} />
              <ModelSelectorName>{selectedModel?.name ?? value.modelId}</ModelSelectorName>
            </>
          ) : (
            <span className="text-muted-foreground">{nullLabel ?? t("preferences.none")}</span>
          )}
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        </ModelSelectorTrigger>
        <ModelSelectorContent finalFocus={skipFinalFocus ? false : undefined}>
          <ModelSelectorInput placeholder={t("preferences.searchModels")} />
          <ModelSelectorList>
            {nullLabel && (
              <ModelSelectorItem
                onSelect={() => { onChange(null); setOpen(false) }}
                value={nullLabel}
                className={!value ? "bg-primary/10" : undefined}
              >
                <span className="text-muted-foreground">{nullLabel}</span>
              </ModelSelectorItem>
            )}
            <ModelSelectorEmpty>{t("preferences.noModelsFound")}</ModelSelectorEmpty>
            {groups.map(({ provider, models }) => (
              <ModelSelectorGroup heading={provider.name} key={provider.id}>
                {models.map((model) => (
                  <ModelSelectorItem
                    key={`${provider.id}/${model.id}`}
                    onSelect={() => {
                      onChange({ providerId: provider.id, modelId: model.id })
                      setOpen(false)
                    }}
                    value={`${provider.name} ${model.name} ${model.id}`}
                    className={
                      value?.providerId === provider.id && value.modelId === model.id
                        ? "bg-primary/10"
                        : undefined
                    }
                  >
                    <ModelSelectorLogo provider={provider.id} />
                    <ModelSelectorName>{model.name}</ModelSelectorName>
                    <ModalityIcons
                      modalities={model.modalities?.input}
                      className="size-3 shrink-0 text-muted-foreground"
                    />
                    {model.reasoning && (
                      <BrainIcon className="size-3 shrink-0 text-muted-foreground" />
                    )}
                  </ModelSelectorItem>
                ))}
              </ModelSelectorGroup>
            ))}
          </ModelSelectorList>
          <div className="border-t p-1">
            <Button
              variant="ghost"
              className="w-full justify-start gap-2 text-xs"
              onClick={() => {
                // Deterministic handoff: it marks the intention and closes the selector. The
                // settings only opens in onOpenChangeComplete, when this dialog
                // has finished leaving — the 120ms setTimeout disputed with the
                // 100ms exit animation.
                setSkipFinalFocus(true)
                pendingSettings.current = true
                setOpen(false)
              }}
            >
              <SettingsIcon className="size-3.5" />
              {groups.length === 0 ? t("preferences.configureProvider") : t("preferences.manageProviders")}
            </Button>
          </div>
        </ModelSelectorContent>
      </ModelSelector>
      {action}
      </div>
    </div>
  )
}

