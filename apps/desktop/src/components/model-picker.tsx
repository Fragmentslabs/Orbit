import { useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { BrainIcon, ChevronDownIcon, ListRestartIcon, Plug, SettingsIcon, TriangleAlertIcon, XIcon } from "lucide-react"
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
import { useEnvProviders } from "@/src/hooks/use-env-providers"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useSessionModel, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { useModelRotationStore, ROTATION_DRAFT_KEY } from "@/src/stores/model-rotation-store"
import { useRotationUi } from "@/src/stores/rotation-ui"
import { cn } from "@/lib/utils"
import { isKnownModel } from "@/src/lib/model-migration"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

const MAX_MODELS_PER_PROVIDER = 40

/**
 * Real model selector: it lists the models of the connected providers
 * (models.dev catalog), grouped by provider, with a reasoning indicator.
 * The model is PER CHAT: `sessionId` decides which override to read/write
 * (undefined = new chat, uses the draft until the first send).
 *
 * Controlled mode (dialogs — e.g. worker/vision): when `value` is passed,
 * the selection comes from props, the session recents are hidden and `filter` can
 * restrict the listed models (e.g. vision only, tool_call only).
 */
export function ModelPicker({ sessionId, open: openProp, onOpenChange: onOpenChangeProp, hideTrigger, triggerClassName, value, onValueChange, filter, nullLabel, hideRotationOptions }: {
  sessionId?: string
  /** External control of the dialog (used by the quick settings menu) */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Hides the trigger — useful when another element opens the dialog */
  hideTrigger?: boolean
  /** Extra classes on the trigger (e.g. styling it as a form field) */
  triggerClassName?: string
  /** Controlled mode: selection coming from props (settings dialogs) */
  value?: SelectedModel | null
  onValueChange?: (model: SelectedModel | null) => void
  /** Filter by model (e.g. only vision models) */
  filter?: (provider: CatalogProvider, model: CatalogModel) => boolean
  /** Label of the "none" item at the top (only in controlled mode) */
  nullLabel?: string
  /**
   * Hides EVERYTHING of rotation (the "Rotations" group and the "Create rotation" footer):
   * used when the selector is opened INSIDE the rotation editor (choice of
   * model for a slot) — showing rotation options there would be a loop.
   */
  hideRotationOptions?: boolean
}) {
  const { t } = useTranslation()
  const [internalOpen, setInternalOpen] = useState(false)
  const [skipFinalFocus, setSkipFinalFocus] = useState(false)
  const pendingSettings = useRef(false)
  // Handoff of the rotation item/footer: it marks the intention and opens the modal in
  // onOpenChangeComplete (same pattern as the providers button, :247-255).
  const pendingRotation = useRef<{ id: string | null } | null>(null)
  const openSettings = useSettingsUi((s) => s.openSettings)
  const openRotation = useRotationUi((s) => s.openRotation)
  const open = openProp ?? internalOpen
  const onOpenChange = onOpenChangeProp ?? setInternalOpen
  // The models of the machine on screen: another desktop's own when one is the environment.
  const { catalog, connectedProviders, remote: remoteEnv, loading: providersLoading } = useEnvProviders()
  const rotations = useModelRotationStore((s) => s.rotations)
  const sessionRotationId = useModelRotationStore((s) => s.sessionOverrides[sessionId ?? ROTATION_DRAFT_KEY])
  const selectRotation = useModelRotationStore((s) => s.selectRotation)
  // Rotation chosen for this chat (trigger and highlight in the group)
  const activeRotation = sessionRotationId ? rotations.find((r) => r.id === sessionRotationId) ?? null : null
  const sessionSelected = useSessionModel(sessionId)
  const recents = useSessionModelPrefs((s) => s.recents)
  const selectModel = useSessionModelPrefs((s) => s.selectModel)
  const clearModel = useSessionModelPrefs((s) => s.clear)
  const removeRecent = useSessionModelPrefs((s) => s.removeRecent)
  const loading = providersLoading
  const error = useProviderStore((s) => s.error)
  // No provider configured (first run): the trigger adopts the same
  // visual language of the ProviderHintCard (Plug icon in primary + background
  // tint) and points to the selector footer ("Configure a provider")
  const noProvider = useNoProviderConnected() && !remoteEnv

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

  // Recents: only models still in the catalog and from connected providers
  // (hidden in controlled mode — the choice there belongs to worker/vision, not to the chat)
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
  // A saved model that left the catalog without a successor (renames were already
  // migrated): it warns, instead of a "Select model" that just looks empty —
  // the send would go on to an id the provider may not even serve anymore.
  const unavailable = !loading && !error && !isKnownModel(catalog, selected)

  const pick = (providerId: string, modelId: string) => {
    if (controlled) {
      onValueChange?.({ providerId, modelId })
    } else {
      selectModel(sessionId, providerId, modelId)
      // Model and rotation are mutually exclusive in the chat
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
          <ModelSelectorTrigger render={<Button className={cn("h-7 gap-1 px-1.5 text-xs", noProvider && "border-primary/30 bg-primary/10 hover:bg-primary/15 aria-expanded:bg-primary/15 dark:bg-primary/15 dark:hover:bg-primary/20", triggerClassName)} variant="ghost" />}>
            {noProvider ? (
              <>
                {/* Attention state: same language as the ProviderHintCard — Plug
                    icon in primary + label in foreground, no animation */}
                <Plug className="size-3.5 shrink-0 text-primary" aria-hidden />
                <ModelSelectorName className="text-foreground/80">{t("modelPicker.noProvider")}</ModelSelectorName>
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
                    {unavailable ? (
                      <TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" aria-hidden />
                    ) : (
                      <ModelSelectorLogo provider={selected?.providerId ?? "openai"} />
                    )}
                    <ModelSelectorName
                      className={unavailable ? "text-destructive" : undefined}
                      title={unavailable ? t("modelPicker.unavailableHint", { model: selected?.modelId }) : undefined}
                    >
                      {loading
                        ? t("modelPicker.loading")
                        : unavailable
                          ? t("modelPicker.unavailable")
                          : selectedModel?.name ?? (error ? t("modelPicker.error") : t("modelPicker.select"))}
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
            {!controlled && !hideRotationOptions && !remoteEnv && rotations.length > 0 && (
              <ModelSelectorGroup heading={t("modelPicker.rotation")}>
                {rotations.map((rotation) => {
                  const isSelectedRotation = sessionRotationId === rotation.id
                  return (
                    <ModelSelectorItem
                      key={rotation.id}
                      onSelect={() => {
                        // Choosing the rotation pins the chat to it, like a model
                        // (clearing the pinned model); clicking again undoes it.
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
                          
                            <Truncate>
                                <span className="truncate">
                                {t("rotation.slotsLabel", { count: rotation.models.length })}
                              </span>
                            </Truncate>
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
                      
                        <Truncate>
                            <span className="w-full truncate text-[10px] leading-tight text-muted-foreground">
                            {provider.name}
                          </span>
                        </Truncate>
                    </span>
                    <ModalityIcons
                      modalities={model.modalities?.input}
                      className="size-3 shrink-0 text-muted-foreground"
                    />
                    {model.reasoning && (
                      <BrainIcon className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <Hint label={t("modelPicker.removeRecent")}>
                      <button
                        type="button"
                        tabIndex={-1}

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
                    </Hint>
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
                // Deterministic handoff: it marks the intention and closes the selector. The
                // settings only opens in onOpenChangeComplete, when this dialog
                // has finished leaving — the 120ms setTimeout disputed with the
                // 100ms exit animation.
                setSkipFinalFocus(true)
                pendingSettings.current = true
                onOpenChange(false)
              }}
            >
              <SettingsIcon className="size-3.5" />
              {groups.length === 0 ? t("preferences.configureProvider") : t("preferences.manageProviders")}
            </Button>
            {!hideRotationOptions && !remoteEnv && (
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
