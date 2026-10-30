import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Contrast, Command, Eye, Sparkles, Volume2 } from "lucide-react"
import { modelSupportsVision } from "@shared/chat"
import { OVERLAY_OPACITY_MIN, type OverlayOpenMode, type OverlaySettings } from "@shared/overlay"
import { Button } from "@/components/ui/button"
import { ModelField } from "@/src/components/model-field"
import { SettingRow, SettingSelect, SettingSwitch } from "@/src/components/settings-row"
import { ModelThinkingMenu } from "@/src/components/thinking-menu"
import { overlayApi } from "@/src/lib/ipc"
import { useAppSettings } from "@/src/stores/app-settings"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Preferences → Overlay: the global shortcut (⇧⌘space), the panel model with the
 * thinking level, the vision mode and the prerequisites of what the panel uses.
 *
 * The rule of the screen is the same as the feature's: everything the agent needs to ACT
 * appears here with a state (on/off) and the path to turn it on. What
 * is turned off it says it cannot do — it never invents.
 */
export function OverlayPanel() {
  const { t } = useTranslation()
  const overlay = useAppSettings((s) => s.settings.overlay)
  const voice = useAppSettings((s) => s.settings.voice)
  const computer = useAppSettings((s) => s.settings.computer)
  const update = useAppSettings((s) => s.update)
  const catalog = useProviderStore((s) => s.catalog)
  const selectedModel = useProviderStore((s) => s.selectedModel)
  const visionModel = useProviderStore((s) => s.visionModel)
  const setVisionModel = useProviderStore((s) => s.setVisionModel)
  const openSettings = useSettingsUi((s) => s.openSettings)
  const [status, setStatus] = useState<{ shortcut: string; ok: boolean; error?: string } | null>(null)

  useEffect(() => {
    void overlayApi.status().then(setStatus)
  }, [overlay.enabled])

  const set = (patch: Partial<OverlaySettings>) => update({ overlay: { ...overlay, ...patch } })
  const callReady = voice.tts.enabled && voice.stt.enabled
  const opacity = Math.round(overlay.opacity * 100)

  // Effective model of the panel: the one chosen here or the conversation's.
  const model = overlay.model ?? selectedModel
  const canSee = model ? modelSupportsVision(catalog[model.providerId], model.modelId) : false
  const visionReady = overlay.vision && !!visionModel
  const screenReady = visionReady || canSee
  const visionName = visionModel
    ? (catalog[visionModel.providerId]?.models[visionModel.modelId]?.name ?? visionModel.modelId)
    : null

  const visionDescription = !overlay.vision
    ? t("overlaySettings.vision.off")
    : visionModel
      ? t("overlaySettings.vision.description")
      : t("overlaySettings.vision.needsModel")

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">{t("overlaySettings.title")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("overlaySettings.description")}</p>
      </div>

      {status && !status.ok && overlay.enabled && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {t("overlaySettings.shortcutConflict")}
        </p>
      )}

      <SettingRow
        icon={Command}
        title={t("overlaySettings.shortcut.title")}
        description={t("overlaySettings.shortcut.description")}
      >
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void overlayApi.open()}>
            {t("overlaySettings.openNow")}
          </Button>
          <SettingSwitch
            checked={overlay.enabled}
            onChange={(enabled) => set({ enabled })}
            label={t("overlaySettings.shortcut.title")}
          />
        </div>
      </SettingRow>

      <SettingRow
        icon={Volume2}
        title={t("overlaySettings.openMode.title")}
        description={callReady ? t("overlaySettings.openMode.description") : t("overlaySettings.openMode.needsVoice")}
      >
        <SettingSelect<OverlayOpenMode>
          value={callReady && overlay.openInCall ? "call" : "text"}
          disabled={!callReady}
          onChange={(mode) => set({ openInCall: mode === "call" })}
          options={[
            { value: "text", label: t("overlaySettings.openMode.text") },
            { value: "call", label: t("overlaySettings.openMode.call") },
          ]}
        />
      </SettingRow>

      {/* Panel model: the selector and, next to it, the thinking level of THIS
          model — the same per-model map the chat input reads. */}
      <div className="rounded-lg border border-border p-3">
        <ModelField
          label={t("overlaySettings.model.title")}
          value={overlay.model}
          onChange={(next) => set({ model: next })}
          nullLabel={t("overlaySettings.model.none")}
          action={<ModelThinkingMenu model={model} />}
        />
        <p className="mt-1 text-[11px] leading-tight text-muted-foreground">{t("overlaySettings.model.description")}</p>
        {model && !canSee && (
          <p
            className={cn(
              "mt-2 text-[11px] leading-tight",
              visionReady ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300",
            )}
          >
            {visionReady ? t("overlaySettings.vision.viaVision") : t("overlaySettings.vision.textOnly")}
          </p>
        )}
        {!model && <p className="mt-2 text-[11px] text-muted-foreground">{t("overlaySettings.model.noModel")}</p>}
      </div>

      <SettingRow icon={Eye} title={t("overlaySettings.vision.title")} description={visionDescription}>
        <SettingSwitch
          checked={overlay.vision}
          onChange={(vision) => set({ vision })}
          label={t("overlaySettings.vision.title")}
        />
      </SettingRow>

      {/* Only models that can see: choosing a blind one here would be choosing nothing. */}
      <div className="pl-11">
        <ModelField
          label={t("overlaySettings.vision.model")}
          value={visionModel}
          // Choosing a model turns the mode on (same convention as the vision
          // dialog of the chat); clearing does not force it off.
          onChange={(next) => {
            setVisionModel(next)
            if (next) set({ vision: true })
          }}
          nullLabel={t("overlaySettings.vision.none")}
          filter={(provider, candidate) => modelSupportsVision(provider, candidate.id)}
        />
      </div>

      <SettingRow
        icon={Sparkles}
        title={t("overlaySettings.persona.title")}
        description={t("overlaySettings.persona.description")}
      >
        <SettingSwitch
          checked={overlay.persona}
          onChange={(persona) => set({ persona })}
          label={t("overlaySettings.persona.title")}
        />
      </SettingRow>

      <SettingRow
        icon={Contrast}
        title={t("overlaySettings.opacity.title")}
        description={t("overlaySettings.opacity.description")}
      >
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={Math.round(OVERLAY_OPACITY_MIN * 100)}
            max={100}
            step={5}
            value={opacity}
            aria-label={t("overlaySettings.opacity.title")}
            onChange={(event) => set({ opacity: Number(event.target.value) / 100 })}
            className="h-1 w-36 cursor-pointer accent-primary"
          />
          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{opacity}%</span>
        </div>
      </SettingRow>

      {/* Prerequisites: what the panel can do, with state and the path
          to turn it on. It is the picture of what the agent will say it cannot do. */}
      <div className="rounded-lg border border-border p-3">
        <p className="text-xs font-medium">{t("overlaySettings.prerequisites.title")}</p>
        <ul className="mt-1.5 flex flex-col">
          <Capability
            ok={screenReady}
            label={t("overlaySettings.prerequisites.screen")}
            detail={
              visionReady
                ? `${t("overlaySettings.prerequisites.screenVision")}${visionName ? ` · ${visionName}` : ""}`
                : canSee
                  ? t("overlaySettings.prerequisites.screenModel")
                  : t("overlaySettings.prerequisites.off")
            }
          />
          <Capability
            ok={voice.tts.enabled}
            label={t("overlaySettings.prerequisites.speech")}
            detail={voice.tts.enabled ? t("overlaySettings.prerequisites.on") : t("overlaySettings.prerequisites.off")}
            onConfigure={() => openSettings("voice")}
          />
          <Capability
            ok={voice.stt.enabled}
            label={t("overlaySettings.prerequisites.dictation")}
            detail={voice.stt.enabled ? t("overlaySettings.prerequisites.on") : t("overlaySettings.prerequisites.off")}
            onConfigure={() => openSettings("voice")}
          />
          <Capability
            ok={computer.enabled}
            label={t("overlaySettings.prerequisites.computer")}
            detail={computer.enabled ? t("overlaySettings.prerequisites.on") : t("overlaySettings.prerequisites.off")}
            onConfigure={() => openSettings("computer")}
          />
        </ul>
        <p className="mt-2 text-[11px] leading-tight text-muted-foreground">
          {t("overlaySettings.prerequisites.hint")}
        </p>
      </div>
    </div>
  )
}

/** A capability of the panel: state, detail and, when it lives in another tab, the shortcut. */
function Capability({
  ok,
  label,
  detail,
  onConfigure,
}: {
  ok: boolean
  label: string
  detail: string
  onConfigure?: () => void
}) {
  const { t } = useTranslation()
  return (
    <li className="flex items-center gap-2 py-1">
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", ok ? "bg-emerald-500" : "bg-muted-foreground/40")}
      />
      <span className="text-xs">{label}</span>
      <Truncate text={detail}>
        <span className="truncate text-[11px] text-muted-foreground">{detail}</span>
      </Truncate>
      {onConfigure && (
        <button
          type="button"
          onClick={onConfigure}
          className="ml-auto shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t("overlaySettings.prerequisites.open")}
        </button>
      )}
    </li>
  )
}
