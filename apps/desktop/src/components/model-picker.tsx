import { useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { BrainIcon, ChevronDownIcon, ListRestartIcon, SettingsIcon, XIcon } from "lucide-react"
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
import type { CatalogModel, CatalogProvider } from "@shared/chat"
import { useProviderStore, useNoProviderConnected, type SelectedModel } from "@/src/stores/provider-store"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useSessionModel, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { useModelRotationStore, ROTATION_DRAFT_KEY } from "@/src/stores/model-rotation-store"
import { useRotationUi } from "@/src/stores/rotation-ui"
import { cn } from "@/lib/utils"

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
export function ModelPicker({ sessionId, open: openProp, onOpenChange: onOpenChangeProp, hideTrigger, triggerClassName, value, onValueChange, filter, nullLabel, hideRotationOptions }: {
  sessionId?: string
  /** Controle externo do diálogo (usado pelo menu de configurações rápidas) */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Oculta o trigger — útil quando outro elemento abre o diálogo */
  hideTrigger?: boolean
  /** Classes extras no trigger (ex.: estilizá-lo como campo de formulário) */
  triggerClassName?: string
  /** Modo controlado: seleção vinda de props (dialogs de configuração) */
  value?: SelectedModel | null
  onValueChange?: (model: SelectedModel | null) => void
  /** Filtro por modelo (ex.: apenas modelos com visão) */
  filter?: (provider: CatalogProvider, model: CatalogModel) => boolean
  /** Rótulo do item "nenhum" no topo (só no modo controlado) */
  nullLabel?: string
  /**
   * Oculta TUDO de rotação (grupo "Rotações" e o footer "Criar rotação"):
   * usado quando o seletor é aberto DENTRO do editor de rotações (escolha de
   * modelo de um slot) — mostrar opções de rotação ali seria um loop.
   */
  hideRotationOptions?: boolean
}) {
  const { t } = useTranslation()
  const [internalOpen, setInternalOpen] = useState(false)
  const [skipFinalFocus, setSkipFinalFocus] = useState(false)
  const pendingSettings = useRef(false)
  // Handoff do item/footer de rotação: marca a intenção e abre o modal no
  // onOpenChangeComplete (mesmo padrão do botão de provedores, :247-255).
  const pendingRotation = useRef<{ id: string | null } | null>(null)
  const openSettings = useSettingsUi((s) => s.openSettings)
  const openRotation = useRotationUi((s) => s.openRotation)
  const open = openProp ?? internalOpen
  const onOpenChange = onOpenChangeProp ?? setInternalOpen
  const catalog = useProviderStore((s) => s.catalog)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)
  const rotations = useModelRotationStore((s) => s.rotations)
  const sessionRotationId = useModelRotationStore((s) => s.sessionOverrides[sessionId ?? ROTATION_DRAFT_KEY])
  const selectRotation = useModelRotationStore((s) => s.selectRotation)
  // Rotação escolhida para este chat (trigger e destaque no grupo)
  const activeRotation = sessionRotationId ? rotations.find((r) => r.id === sessionRotationId) ?? null : null
  const sessionSelected = useSessionModel(sessionId)
  const recents = useSessionModelPrefs((s) => s.recents)
  const selectModel = useSessionModelPrefs((s) => s.selectModel)
  const clearModel = useSessionModelPrefs((s) => s.clear)
  const removeRecent = useSessionModelPrefs((s) => s.removeRecent)
  const loading = useProviderStore((s) => s.loading)
  const error = useProviderStore((s) => s.error)
  // Sem provedor configurado (primeira execução): o trigger pulsa e aponta
  // para o footer do seletor ("Configurar um provedor")
  const noProvider = useNoProviderConnected()

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
      // Modelo e rotação são mutuamente exclusivos no chat
      selectRotation(sessionId, null)
    }
    onOpenChange(false)
  }

  return (
    <>
      <ModelSelector
        open={open}
        onOpenChange={onOpenChange}
        onOpenChangeComplete={(isOpen) => {
          if (isOpen) return
          setSkipFinalFocus(false)
          if (pendingRotation.current) {
            const target = pendingRotation.current
            pendingRotation.current = null
            openRotation(target.id)
            return
          }
          if (!pendingSettings.current) return
          pendingSettings.current = false
          openSettings("providers")
        }}
      >
        {!hideTrigger && (
          <ModelSelectorTrigger render={<Button className={cn("h-7 gap-1 px-1.5 text-xs", noProvider && "ring-2 ring-primary/40", triggerClassName)} variant="ghost" />}>
            {noProvider ? (
              <>
                {/* Estado de atenção: dot pulsante + label, sem logo de provider */}
                <span className="relative flex size-2 shrink-0" aria-hidden>
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
                <ModelSelectorName className="text-primary">{t("modelPicker.noProvider")}</ModelSelectorName>
              </>
            ) : (
              <>
                {activeRotation ? (
                  <>
                    <ListRestartIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <ModelSelectorName>{activeRotation.name}</ModelSelectorName>
                  </>
                ) : (
                  <>
                    <ModelSelectorLogo provider={selected?.providerId ?? "openai"} />
                    <ModelSelectorName>
                      {loading ? t("modelPicker.loading") : selectedModel?.name ?? (error ? t("modelPicker.error") : t("modelPicker.select"))}
                    </ModelSelectorName>
                  </>
                )}
              </>
            )}
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
            {!controlled && !hideRotationOptions && rotations.length > 0 && (
              <ModelSelectorGroup heading={t("modelPicker.rotation")}>
                {rotations.map((rotation) => {
                  const isSelectedRotation = sessionRotationId === rotation.id
                  return (
                    <ModelSelectorItem
                      key={rotation.id}
                      onSelect={() => {
                        // Escolher a rotação pina o chat nela, como um modelo
                        // (limpando o modelo pinado); clicar de novo desfaz.
                        const isSelected = sessionRotationId === rotation.id
                        if (!isSelected) clearModel(sessionId ?? ROTATION_DRAFT_KEY)
                        selectRotation(sessionId, isSelected ? null : rotation.id)
                        onOpenChange(false)
                      }}
                      value={`${rotation.name} ${t("modelPicker.rotation")}`}
                      className={isSelectedRotation ? "bg-primary/10" : undefined}
                    >
                      <ListRestartIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <ModelSelectorName className="w-full">{rotation.name}</ModelSelectorName>
                        <span className="flex w-full items-center gap-1 text-[10px] leading-tight text-muted-foreground">
                          <span className="truncate">
                            {t("rotation.slotsLabel", { count: rotation.models.length })}
                          </span>
                        </span>
                      </span>
                    </ModelSelectorItem>
                  )
                })}
              </ModelSelectorGroup>
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
                // Handoff determinístico: marca a intenção e fecha o seletor. O
                // settings só abre no onOpenChangeComplete, quando este dialog
                // terminou de sair — o setTimeout de 120ms disputava com a
                // animação de saída de 100ms.
                setSkipFinalFocus(true)
                pendingSettings.current = true
                onOpenChange(false)
              }}
            >
              <SettingsIcon className="size-3.5" />
              {groups.length === 0 ? t("preferences.configureProvider") : t("preferences.manageProviders")}
            </Button>
            {!hideRotationOptions && (
              <Button
                variant="ghost"
                className="w-full justify-start gap-2 text-xs"
                onClick={() => {
                  setSkipFinalFocus(true)
                  pendingRotation.current = { id: null }
                  onOpenChange(false)
                }}
              >
                <ListRestartIcon className="size-3.5" />
                {t("modelPicker.createRotation")}
              </Button>
            )}
          </div>
        </ModelSelectorContent>
      </ModelSelector>
    </>
  )
}
