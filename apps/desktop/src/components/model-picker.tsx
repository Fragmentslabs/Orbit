import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { BrainIcon, ChevronDownIcon, SettingsIcon, XIcon } from "lucide-react"
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
import { SettingsDialog } from "@/src/components/settings-dialog"
import { ModalityIcons } from "@/src/components/ai/modality-icons"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionModel, useSessionModelPrefs } from "@/src/stores/session-model-prefs"

const MAX_MODELS_PER_PROVIDER = 40

/**
 * Seletor de modelos real: lista os modelos dos provedores conectados
 * (catálogo models.dev), agrupados por provedor, com indicador de reasoning.
 * O modelo é POR CHAT: `sessionId` decide qual override ler/escrever
 * (undefined = chat novo, usa o draft até o primeiro envio).
 */
export function ModelPicker({ sessionId, open: openProp, onOpenChange: onOpenChangeProp, hideTrigger }: {
  sessionId?: string
  /** Controle externo do diálogo (usado pelo menu de configurações rápidas) */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Oculta o trigger — útil quando outro elemento abre o diálogo */
  hideTrigger?: boolean
}) {
  const { t } = useTranslation()
  const [internalOpen, setInternalOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [skipFinalFocus, setSkipFinalFocus] = useState(false)
  const open = openProp ?? internalOpen
  const onOpenChange = onOpenChangeProp ?? setInternalOpen
  const catalog = useProviderStore((s) => s.catalog)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)
  const selected = useSessionModel(sessionId)
const recents = useSessionModelPrefs((s) => s.recents)
  const selectModel = useSessionModelPrefs((s) => s.selectModel)
  const removeRecent = useSessionModelPrefs((s) => s.removeRecent)
  const loading = useProviderStore((s) => s.loading)
  const error = useProviderStore((s) => s.error)

  const groups = useMemo(
    () =>
      connectedProviders
        .filter((id) => catalog[id])
        .map((id) => ({
          provider: catalog[id],
          models: Object.values(catalog[id].models)
            .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""))
            .slice(0, MAX_MODELS_PER_PROVIDER),
        })),
    [catalog, connectedProviders],
  )

  // Recents: só modelos ainda no catálogo e de provedores conectados
  const recentModels = useMemo(
    () =>
      recents
        .map((r) => ({ recent: r, provider: catalog[r.providerId], model: catalog[r.providerId]?.models[r.modelId] }))
        .filter((entry): entry is { recent: NonNullable<typeof entry.recent>; provider: NonNullable<typeof entry.provider>; model: NonNullable<typeof entry.model> } =>
          connectedProviders.includes(entry.recent.providerId) && !!entry.provider && !!entry.model,
        ),
    [recents, catalog, connectedProviders],
  )

  const selectedModel = selected ? catalog[selected.providerId]?.models[selected.modelId] : undefined

  const pick = (providerId: string, modelId: string) => {
    selectModel(sessionId, providerId, modelId)
    onOpenChange(false)
  }

  return (
    <>
      <ModelSelector open={open} onOpenChange={onOpenChange}>
        {!hideTrigger && (
          <ModelSelectorTrigger render={<Button className="h-7 gap-1 px-1.5 text-xs" variant="ghost" />}>
            <ModelSelectorLogo provider={selected?.providerId ?? "openai"} />
            <ModelSelectorName>
              {loading ? t("modelPicker.loading") : selectedModel?.name ?? (error ? t("modelPicker.error") : t("modelPicker.select"))}
            </ModelSelectorName>
            <ChevronDownIcon className="size-3 text-muted-foreground" />
          </ModelSelectorTrigger>
        )}
        <ModelSelectorContent finalFocus={skipFinalFocus ? false : undefined}>
          <ModelSelectorInput placeholder={t("preferences.searchModels")} />
          <ModelSelectorList>
            <ModelSelectorEmpty>{t("preferences.noModelsFound")}</ModelSelectorEmpty>
            {recentModels.length > 0 && (
              <ModelSelectorGroup heading={t("modelPicker.recent")}>
                {recentModels.map(({ recent, provider, model }) => (
                  <ModelSelectorItem
                    key={`recent-${recent.providerId}/${recent.modelId}`}
                    onSelect={() => pick(recent.providerId, recent.modelId)}
                    value={`${provider.name} ${model.name} ${model.id} ${t("modelPicker.recent")}`}
                    className={
                      selected?.providerId === recent.providerId && selected.modelId === recent.modelId
                        ? "bg-primary/10"
                        : undefined
                    }
                  >
                    <ModelSelectorLogo provider={recent.providerId} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <ModelSelectorName className="w-full">{model.name}</ModelSelectorName>
                      <span className="w-full truncate text-[10px] leading-tight text-muted-foreground">
                        {provider.name}
                      </span>
                    </span>
                    <ModalityIcons
                      modalities={model.modalities?.input}
                      className="size-3 shrink-0 text-muted-foreground"
                    />
                    {model.reasoning && (
                      <BrainIcon className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <button
                      type="button"
                      tabIndex={-1}
                      title={t("modelPicker.removeRecent")}
                      aria-label={t("modelPicker.removeRecent")}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        removeRecent(recent.providerId, recent.modelId)
                      }}
                      className="hidden shrink-0 cursor-pointer items-center rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted group-hover/command-item:flex hover:text-foreground"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </ModelSelectorItem>
                ))}
              </ModelSelectorGroup>
            )}
            {groups.map(({ provider, models }) => (
              <ModelSelectorGroup heading={provider.name} key={provider.id}>
                {models.map((model) => (
                  <ModelSelectorItem
                    key={`${provider.id}/${model.id}`}
                    onSelect={() => pick(provider.id, model.id)}
                    value={`${provider.name} ${model.name} ${model.id}`}
                    className={
                      selected?.providerId === provider.id && selected.modelId === model.id
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
                setSkipFinalFocus(true)
                onOpenChange(false)
                // Aguarda o dialog de seleção fechar completamente (animação ~100ms)
                // para evitar conflito de foco com o input autofocus do settings.
                setTimeout(() => setSettingsOpen(true), 120)
              }}
            >
              <SettingsIcon className="size-3.5" />
              {groups.length === 0 ? t("preferences.configureProvider") : t("preferences.manageProviders")}
            </Button>
          </div>
        </ModelSelectorContent>
      </ModelSelector>
      <SettingsDialog open={settingsOpen} onOpenChange={(next) => { setSettingsOpen(next); if (!next) setSkipFinalFocus(false) }} />
    </>
  )
}
