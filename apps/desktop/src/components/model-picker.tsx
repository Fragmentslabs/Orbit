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
import type { CatalogModel, CatalogProvider } from "@shared/chat"
import { useProviderStore, type SelectedModel } from "@/src/stores/provider-store"
import { useSessionModel, useSessionModelPrefs } from "@/src/stores/session-model-prefs"

const MAX_MODELS_PER_PROVIDER = 40

/**
 * Seletor de modelos real: lista os modelos dos provedores conectados
 * (catálogo models.dev), agrupados por provedor, com indicador de reasoning.
 * O modelo é POR CHAT: `sessionId` decide qual override ler/escrever
 * (undefined = chat novo, usa o draft até o primeiro envio).
 *
 * Modo controlado (dialogs — ex.: worker/visão): quando `value` é passado,
 * a seleção vem de props, recents da sessão são ocultados e `filter` pode
 * restringir os modelos listados (ex.: só visão, só tool_call).
 */
export function ModelPicker({ sessionId, open: openProp, onOpenChange: onOpenChangeProp, hideTrigger, value, onValueChange, filter, nullLabel }: {
  sessionId?: string
  /** Controle externo do diálogo (usado pelo menu de configurações rápidas) */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Oculta o trigger — útil quando outro elemento abre o diálogo */
  hideTrigger?: boolean
  /** Modo controlado: seleção vinda de props (dialogs de configuração) */
  value?: SelectedModel | null
  onValueChange?: (model: SelectedModel | null) => void
  /** Filtro por modelo (ex.: apenas modelos com visão) */
  filter?: (provider: CatalogProvider, model: CatalogModel) => boolean
  /** Rótulo do item "nenhum" no topo (só no modo controlado) */
  nullLabel?: string
}) {
  const { t } = useTranslation()
  const [internalOpen, setInternalOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [skipFinalFocus, setSkipFinalFocus] = useState(false)
  const open = openProp ?? internalOpen
  const onOpenChange = onOpenChangeProp ?? setInternalOpen
  const catalog = useProviderStore((s) => s.catalog)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)
  const sessionSelected = useSessionModel(sessionId)
  const recents = useSessionModelPrefs((s) => s.recents)
  const selectModel = useSessionModelPrefs((s) => s.selectModel)
  const removeRecent = useSessionModelPrefs((s) => s.removeRecent)
  const loading = useProviderStore((s) => s.loading)
  const error = useProviderStore((s) => s.error)

  const controlled = value !== undefined
  const selected = controlled ? value : sessionSelected

  const groups = useMemo(
    () =>
      connectedProviders
        .filter((id) => catalog[id])
        .map((id) => {
          const provider = catalog[id]
          return {
            provider,
            models: Object.values(provider.models)
              .filter((model) => (filter ? filter(provider, model) : true))
              .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""))
              .slice(0, MAX_MODELS_PER_PROVIDER),
          }
        })
        .filter((g) => g.models.length > 0),
    [catalog, connectedProviders, filter],
  )

  // Recents: só modelos ainda no catálogo e de provedores conectados
  // (ocultos no modo controlado — a escolha ali é de worker/visão, não do chat)
  const recentModels = useMemo(
    () =>
      controlled
        ? []
        : recents
            .map((r) => ({ recent: r, provider: catalog[r.providerId], model: catalog[r.providerId]?.models[r.modelId] }))
            .filter((entry): entry is { recent: NonNullable<typeof entry.recent>; provider: NonNullable<typeof entry.provider>; model: NonNullable<typeof entry.model> } =>
              connectedProviders.includes(entry.recent.providerId) && !!entry.provider && !!entry.model,
            ),
    [recents, catalog, connectedProviders, controlled],
  )

  const selectedModel = selected ? catalog[selected.providerId]?.models[selected.modelId] : undefined

  const pick = (providerId: string, modelId: string) => {
    if (controlled) {
      onValueChange?.({ providerId, modelId })
    } else {
      selectModel(sessionId, providerId, modelId)
    }
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
            {nullLabel && (
              <ModelSelectorItem
                onSelect={() => {
                  onValueChange?.(null)
                  onOpenChange(false)
                }}
                value="__none__"
                className={selected === null ? "bg-primary/10" : undefined}
              >
                <XIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <ModelSelectorName>{nullLabel}</ModelSelectorName>
              </ModelSelectorItem>
            )}
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
