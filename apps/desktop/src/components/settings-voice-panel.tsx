import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AudioLines,
  Check,
  ChevronDown,
  Cpu,
  Download,
  Gauge,
  Languages,
  Mic,
  Phone,
  RefreshCw,
  Sparkles,
  Timer,
  TriangleAlert,
  Volume2,
} from "lucide-react"
import {
  VOICE_CALL_SILENCE_OPTIONS,
  VOICE_DEFAULTS,
  type VoiceEngineId,
  type VoiceHardwareInfo,
  type VoiceModelInfo,
  type VoiceSettings,
  type VoiceStatusSnapshot,
  type VoiceTtsEngine,
} from "@shared/voice"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { SettingRow, SettingSelect, SettingSwitch } from "@/src/components/settings-row"
import { VoicePreviewButton } from "@/src/components/voice-preview-button"
import {
  VoiceModelsSection,
  enginePhase,
  shortModelName,
  type EnginePhase,
  type VoiceModelRow,
} from "@/src/components/voice-models-section"
import { useAudioInputs } from "@/src/hooks/use-audio-inputs"
import { useAppSettings } from "@/src/stores/app-settings"
import { formatSizeMb, modelViews } from "@/src/lib/voice-models"
import { voiceApi } from "@/src/lib/voice-ipc"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Preferences → Voice: TTS (read answers aloud), STT (dictate) and the
 * management of the downloaded models, with the recommendation for this machine.
 *
 * The preferences are the `voice` block of AppSettings, which the renderer keeps and
 * persists — read with the `@shared/voice` defaults as a safety net
 * for an old version saved in localStorage.
 *
 * House rule: the badge (Badge) and the text right below come from the SAME state
 * (see `enginePhase`). A badge saying "not downloaded" with text saying "the package
 * is on disk" is the defect this screen cannot repeat.
 */

/** Transcription engines offered; Parakeet is the preferred one. */
const STT_ENGINES: readonly VoiceEngineId[] = ["parakeet", "whisper"]

/** TTS voices: F1–F5 female, M1–M5 male (Supertonic 3). */
const VOICE_IDS = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"] as const

/** Reading languages: `auto` follows the language of each answer; the others
 *  force the accent; `na` leaves the voice without a language (agnostic). */
const TTS_LANGS = ["auto", "pt", "en", "es", "fr", "de", "it", "na"] as const

/** Dictation languages ("auto" lets the engine detect it). */
const STT_LANGS = ["auto", "pt", "en", "es", "fr", "de", "it", "ja", "zh"] as const

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

/** Inference threads offered — the ceiling is the same as the shared core's. */
const THREAD_STEPS = [1, 2, 3, 4, 6, 8, 12, 16] as const

/** Main process catalog in the screen rows: the `modelViews` view plus the
 *  languages, which the metadata shows as secondary text. */
function catalogRows(catalog: VoiceModelInfo[] | null): VoiceModelRow[] {
  const byId = new Map((Array.isArray(catalog) ? catalog : []).map((model) => [model.id, model]))
  return modelViews(catalog).map((view) => ({ ...view, langs: byId.get(view.id)?.langs ?? [] }))
}

function useVoicePrefs(): { voice: VoiceSettings; updateVoice: (next: Partial<VoiceSettings>) => void } {
  const voice = useAppSettings((s) => s.settings.voice)
  const update = useAppSettings((s) => s.update)
  const safe: VoiceSettings = useMemo(
    () => ({
      tts: { ...VOICE_DEFAULTS.tts, ...(voice?.tts ?? {}) },
      stt: { ...VOICE_DEFAULTS.stt, ...(voice?.stt ?? {}) },
      call: { ...VOICE_DEFAULTS.call, ...(voice?.call ?? {}) },
    }),
    [voice],
  )
  // Merges with what is already saved: whoever touches `tts`/`stt` does not erase the
  // `call` block (nor the other way around).
  const updateVoice = useCallback(
    (next: Partial<VoiceSettings>) => update({ voice: { ...safe, ...next } }),
    [update, safe],
  )
  return { voice: safe, updateVoice }
}

function threadOptions(cpus: number | undefined): string[] {
  const max = Math.max(1, Math.min(16, Math.round(cpus ?? 8)))
  const values: number[] = THREAD_STEPS.filter((n) => n <= max)
  if (!values.includes(max)) values.push(max)
  return values.map(String)
}

function formatSpeed(speed: number): string {
  return `${speed}×`
}

interface CompactOption {
  value: string
  label: string
  /** Full text (the truncated catalog label) for the `title`. */
  title?: string
  /** It appears in the list but cannot be chosen (model not downloaded yet). */
  disabled?: boolean
  /** Discreet complement after the label, only in the list ("not downloaded · 488 MB"). */
  hint?: string
}

/**
 * FIXED width Select inside the panel row — the trigger's `w-fit` is
 * overridden with `w-44!` and the label cuts with an ellipsis. The labels of the voice
 * catalog are whole sentences ("Whisper large-v3-turbo (whisper.cpp) —
 * 574 MB, …"): without the cut, the control stretches and pushes the grid row (the
 * same layout defect for "parakeet-tdt-0.6b-v3"). The full text stays
 * in the `title`; the size and the languages, in the secondary row below.
 */
function CompactSelect({
  value,
  options,
  onChange,
  label,
}: {
  value: string
  options: CompactOption[]
  onChange: (value: string) => void
  label: string
}) {
  const selected = options.find((option) => option.value === value)
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger
        className="w-44! gap-1.5"
        aria-label={label}
        title={selected?.title ?? selected?.label ?? label}
      >
        <Truncate text={selected?.label ?? value}>
          <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? value}</span>
        </Truncate>
      </SelectTrigger>
      <SelectContent className="w-64!">
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            title={option.title ?? option.label}
          >
            {option.label}
            {option.hint && <span className="text-muted-foreground">{option.hint}</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Badge of the engine state — the three states come from `EnginePhase`. */
function phaseBadgeVariant(phase: EnginePhase): "secondary" | "outline" {
  return phase === "ready" ? "secondary" : "outline"
}

export function VoicePanel() {
  const { t } = useTranslation()
  const { voice, updateVoice } = useVoicePrefs()
  const { tts, stt, call } = voice
  const [hardware, setHardware] = useState<VoiceHardwareInfo | null>(null)
  const [catalog, setCatalog] = useState<VoiceModelInfo[] | null>(null)
  const [status, setStatus] = useState<VoiceStatusSnapshot | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [showMoreModels, setShowMoreModels] = useState(false)
  const micInputs = useAudioInputs()

  const models = useMemo(() => catalogRows(catalog), [catalog])

  const refresh = useCallback(async () => {
    try {
      const [report, list, state] = await Promise.all([voiceApi.hardware(), voiceApi.models(), voiceApi.status()])
      setHardware(report)
      setCatalog(Array.isArray(list) ? list : null)
      setStatus(state && typeof state === "object" ? state : null)
      setLoadError(false)
    } catch {
      // Channel not registered (old main process, dev) or invalid response: the panel
      // shows a readable error and keeps going with what it already has — never an empty screen.
      setLoadError(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The main process warns on every state change (download, package extraction, VAD,
  // removal, failure) and the screen re-queries. Without this subscription the "Prepare now"
  // seemed to have no function: the extraction ran in the main process and the badge stayed in
  // "Preparing…" forever, even after the model was ready.
  useEffect(() => voiceApi.onStatusChanged(() => void refresh()), [refresh])

  const engineLabel = useCallback(
    (engine: string): string => {
      if (engine === "parakeet") return t("voice.settings.stt.engineParakeet")
      if (engine === "whisper") return t("voice.settings.stt.engineWhisper")
      return engine
    },
    [t],
  )

  /** `null` = we do not know (status unavailable, or the id out of the snapshot) —
   *  which is NOT the same as "not downloaded": without knowing, the screen states nothing. */
  const downloadedOf = useCallback(
    (modelId: string | null): boolean | null => {
      if (!modelId || !status) return null
      const installed = status.models[modelId]?.installed
      return typeof installed === "boolean" ? installed : null
    },
    [status],
  )

  const sttModels = useMemo(() => models.filter((model) => model.engine === stt.engine), [models, stt.engine])
  const selectedModel = sttModels.find((model) => model.id === stt.modelId) ?? null
  const engineInfo = status?.engines.find((info) => info.engine === stt.engine) ?? null
  const recommendedEngine = hardware?.recommendedEngine ?? null
  const recommendedModel = models.find((model) => model.id === hardware?.recommendedModel) ?? null
  const recommendedModelLabel = recommendedModel?.label ?? hardware?.recommendedModel ?? ""

  // The engine state in ONE place: the badge and the text below are a consequence of it.
  const engineDownloaded = sttModels.some((model) => downloadedOf(model.id) === true)
  const sttPhase = engineInfo ? enginePhase(engineInfo, engineDownloaded) : null
  const engineBadgeKey =
    sttPhase === "ready"
      ? "voice.settings.stt.engineInstalled"
      : sttPhase === "preparing"
        ? "voice.settings.stt.enginePreparing"
        : engineInfo?.available === false && engineDownloaded
          ? "voice.settings.stt.engineUnavailable"
          : "voice.settings.stt.engineMissing"

  // Model "in use": the chosen one; with no choice, the one the ENGINE ITSELF uses in
  // "Automatic" (`autoModelId` — it knows what is on disk) and, with a main process
  // that does not publish that yet, the recommendation or the first one already downloaded.
  const autoModelId = engineInfo?.autoModelId ?? hardware?.recommendedModel ?? null
  const inUseModel =
    selectedModel ??
    (autoModelId ? sttModels.find((model) => model.id === autoModelId) ?? null : null) ??
    sttModels.find((model) => downloadedOf(model.id) === true) ??
    null
  const inUseAuto = stt.modelId === null
  const inUseDownloaded = downloadedOf(inUseModel?.id ?? null)
  const inUseMeta = inUseModel
    ? [formatSizeMb(inUseModel.sizeMb) ?? t("voice.settings.models.sizeUnknown"), inUseModel.langs.join(", ")]
        .filter((part) => !!part)
        .join(" · ")
    : ""
  const recommendedDownloaded = downloadedOf(hardware?.recommendedModel ?? null)
  // The recommendation is already in effect: the same engine and the same model — chosen
  // by hand or through "Automatic", which the engine resolves to it. Then the card becomes
  // a confirmation line; the apply button would have nothing to do.
  const recommendationActive =
    !!hardware &&
    stt.engine === hardware.recommendedEngine &&
    (stt.modelId ?? autoModelId) === hardware.recommendedModel
  const engineModelId = selectedModel?.id ?? sttModels[0]?.id ?? null
  /** Bytes on disk (the Parakeet package counts before extracting: the engine
   *  prepares itself). Without status, we do not know — and then nothing is blocked. */
  const modelOnDisk = (modelId: string): boolean | null => {
    const model = status?.models[modelId]
    if (!model) return null
    return model.downloaded ?? model.installed
  }
  const missingModels = status ? sttModels.filter((model) => modelOnDisk(model.id) === false) : []

  // Chosen microphone that is not plugged in now: it stays in the list (and
  // selected) with the notice, instead of the selector showing an empty value.
  const micMissing = !!stt.micDeviceId && !micInputs.some((input) => input.deviceId === stt.micDeviceId)
  const micOptions: CompactOption[] = [
    { value: "", label: t("voice.settings.stt.micDefault") },
    ...micInputs.map((input, index) => ({
      value: input.deviceId,
      label: input.label || t("voice.settings.stt.micUnnamed", { n: index + 1 }),
    })),
    ...(micMissing ? [{ value: stt.micDeviceId as string, label: t("voice.settings.stt.micMissing") }] : []),
  ]
  const ttsModel = models.find((model) => model.kind === "tts") ?? null
  const ttsDownloaded = downloadedOf(ttsModel?.id ?? null)
  const ttsPhase: EnginePhase = status?.ttsReady ? "ready" : ttsDownloaded ? "preparing" : "missing"

  // Audio priority: the MODEL route (provider) and the LOCAL engine are the
  // two halves of the state. "Voice model" speaks through the provider when the route
  // exists; without it the pipeline falls back to the local one, and the text below says exactly
  // that — no "ready" badge that does not correspond to who is going to speak.
  const modelTts = status?.modelTts
  const modelRouteReady = modelTts?.available === true
  const ttsViaModel = tts.engine === "model" && modelRouteReady
  const ttsUsable = ttsViaModel || status?.ttsReady === true
  const modelTarget = [modelTts?.providerId, modelTts?.modelId].filter(Boolean).join(" · ")
  const ttsPhaseNow: EnginePhase = ttsUsable ? "ready" : ttsPhase
  const ttsReadyKey = ttsViaModel ? "voice.settings.tts.readyModel" : "voice.settings.tts.ready"
  const ttsReadyParams = ttsViaModel ? { model: modelTarget } : undefined

  const startDownload = (modelId: string | null) => {
    if (!modelId) return
    void voiceApi.download(modelId).catch(() => undefined)
  }

  const applyRecommendation = () => {
    if (!hardware) return
    updateVoice({
      tts,
      stt: { ...stt, engine: hardware.recommendedEngine, modelId: hardware.recommendedModel },
    })
  }

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto pr-1">
      <div>
        <p className="text-sm font-semibold">{t("settings.tabs.voice.label")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.tabs.voice.description")}</p>
      </div>

      {/* Unreadable state (missing channel, old main process, invalid response): a
          card with the reason and the try again button — never an empty screen. */}
      {loadError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
            <TriangleAlert className="size-3.5 shrink-0" />
            {t("voice.settings.status.errorTitle")}
          </p>
          <p className="mt-1 text-[11px] leading-tight text-muted-foreground">
            {t("voice.settings.status.loadError")}
          </p>
          <Button size="sm" variant="outline" className="mt-2 gap-1" onClick={() => void refresh()}>
            <RefreshCw className="size-3" />
            {t("voice.settings.status.retry")}
          </Button>
        </div>
      )}

      {/* ── Text into speech ──────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t("voice.settings.sections.tts")}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">{t("voice.settings.sections.ttsHint")}</p>
        </div>

        <SettingRow
          icon={Volume2}
          title={t("voice.settings.tts.enableTitle")}
          description={t("voice.settings.tts.enableHint")}
        >
          <SettingSwitch
            checked={tts.enabled}
            onChange={(enabled) => updateVoice({ tts: { ...tts, enabled }, stt })}
            label={t("voice.settings.tts.enableTitle")}
          />
        </SettingRow>

        {/* Audio priority: where the speech comes out. Compact, in the same pattern
            as the dictation engine selector — the grid row does not stretch. */}
        <SettingRow
          icon={Cpu}
          title={t("voice.settings.tts.engineTitle")}
          description={t("voice.settings.tts.engineHint")}
        >
          <CompactSelect
            label={t("voice.settings.tts.engineTitle")}
            value={tts.engine}
            onChange={(engine) => updateVoice({ tts: { ...tts, engine: engine as VoiceTtsEngine }, stt })}
            options={[
              { value: "model", label: t("voice.settings.tts.engineModel") },
              { value: "local", label: t("voice.settings.tts.engineLocal") },
            ]}
          />
        </SettingRow>

        <SettingRow
          icon={AudioLines}
          title={t("voice.settings.tts.voiceTitle")}
          description={t("voice.settings.tts.voiceHint")}
        >
          <div className="flex items-center gap-1.5">
            <SettingSelect<string>
              value={tts.voice}
              onChange={(next) => updateVoice({ tts: { ...tts, voice: next }, stt })}
              options={VOICE_IDS.map((id) => ({ value: id, label: t(`voice.settings.tts.voice${id}`) }))}
            />
            {/* Listen before choosing: the sample comes out through the same path as the reading. */}
            <VoicePreviewButton voice={tts.voice} lang={tts.lang} speed={tts.speed} engine={tts.engine} />
          </div>
        </SettingRow>

        <SettingRow
          icon={Languages}
          title={t("voice.settings.tts.langTitle")}
          description={t("voice.settings.tts.langHint")}
        >
          <SettingSelect<string>
            value={tts.lang}
            onChange={(next) => updateVoice({ tts: { ...tts, lang: next }, stt })}
            options={TTS_LANGS.map((code) => ({ value: code, label: t(`voice.settings.languages.${code}`) }))}
          />
        </SettingRow>

        <SettingRow
          icon={Gauge}
          title={t("voice.settings.tts.speedTitle")}
          description={t("voice.settings.tts.speedHint")}
        >
          <SettingSelect<string>
            value={String(tts.speed)}
            onChange={(next) => updateVoice({ tts: { ...tts, speed: Number(next) }, stt })}
            options={SPEED_OPTIONS.map((speed) => ({ value: String(speed), label: formatSpeed(speed) }))}
          />
        </SettingRow>

        {/* Text from the SAME state that decides the speech: with the model route, the
            "ready" is its; without it, the pipeline uses the local engine and the sentence
            names the reason — downloaded ≠ ready, and the phase rules the sentence. */}
        {tts.enabled && status && (
          <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
            {ttsPhaseNow === "ready" ? (
              <>
                <Check className="size-3 shrink-0" />
                {t(ttsReadyKey, ttsReadyParams)}
              </>
            ) : (
              <>
                <TriangleAlert className="size-3 shrink-0" />
                {t(
                  ttsPhaseNow === "preparing"
                    ? "voice.settings.tts.downloadedNotReady"
                    : "voice.settings.tts.notReady",
                )}
              </>
            )}
          </p>
        )}

        {/* Why the speech does NOT come out through the model: the preference asks for the provider,
            there is no route, and it is the local engine that is going to speak. */}
        {tts.enabled && status && tts.engine === "model" && !modelRouteReady && (
          <p className="px-1 text-[11px] text-muted-foreground/70">
            {t("voice.settings.tts.engineModelFallback", { reason: modelTts?.reason ?? "" })}
          </p>
        )}
      </div>

      {/* ── Speech into text ──────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 border-t pt-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t("voice.settings.sections.stt")}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">{t("voice.settings.sections.sttHint")}</p>
        </div>

        <SettingRow
          icon={Mic}
          title={t("voice.settings.stt.enableTitle")}
          description={t("voice.settings.stt.enableHint")}
        >
          <SettingSwitch
            checked={stt.enabled}
            onChange={(enabled) => updateVoice({ tts, stt: { ...stt, enabled } })}
            label={t("voice.settings.stt.enableTitle")}
          />
        </SettingRow>

        <SettingRow
          icon={Mic}
          title={t("voice.settings.stt.micTitle")}
          description={t("voice.settings.stt.micHint")}
        >
          <CompactSelect
            label={t("voice.settings.stt.micTitle")}
            value={stt.micDeviceId ?? ""}
            onChange={(micDeviceId) => updateVoice({ tts, stt: { ...stt, micDeviceId: micDeviceId || null } })}
            options={micOptions}
          />
        </SettingRow>

        <SettingRow
          icon={Cpu}
          title={t("voice.settings.stt.engineTitle")}
          description={t("voice.settings.stt.engineHint")}
        >
          <CompactSelect
            label={t("voice.settings.stt.engineTitle")}
            value={stt.engine}
            onChange={(engine) =>
              updateVoice({ tts, stt: { ...stt, engine: engine as VoiceEngineId, modelId: null } })
            }
            options={STT_ENGINES.map((engine) => ({
              value: engine,
              label:
                engine === "parakeet"
                  ? t("voice.settings.stt.enginePreferred", { engine: t("voice.settings.stt.engineParakeet") })
                  : t("voice.settings.stt.engineWhisper"),
            }))}
          />
        </SettingRow>

        {/* Badge and explanation from the SAME state: in "preparing" the text is what is
            missing (extraction + VAD), along with the action to trigger the preparation. */}
        {status && engineInfo && sttPhase && (
          <div className="flex flex-col gap-1.5 px-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <Badge variant={phaseBadgeVariant(sttPhase)} className="shrink-0 text-[10px]">
                {t(engineBadgeKey)}
              </Badge>
              {sttPhase === "preparing" ? (
                <span className="min-w-0">{t("voice.settings.stt.prepareHint")}</span>
              ) : (
                engineInfo.reason && (
                  <span className="min-w-0">{t("voice.settings.stt.engineReason", { reason: engineInfo.reason })}</span>
                )
              )}
              {recommendedEngine && recommendedEngine !== stt.engine && (
                <span className="min-w-0">
                  {t("voice.settings.stt.enginePreferHint", { engine: engineLabel(recommendedEngine) })}
                </span>
              )}
            </div>
            {sttPhase === "preparing" && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1"
                  disabled={!engineModelId}
                  onClick={() => startDownload(engineModelId)}
                >
                  <Timer className="size-3" />
                  {t("voice.settings.stt.prepareNow")}
                </Button>
              </div>
            )}
          </div>
        )}

        <SettingRow
          icon={Download}
          title={t("voice.settings.stt.modelTitle")}
          description={t("voice.settings.stt.modelHint")}
        >
          {sttModels.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">{t("voice.settings.stt.modelNone")}</span>
          ) : (
            <CompactSelect
              label={t("voice.settings.stt.modelTitle")}
              value={stt.modelId ?? ""}
              onChange={(modelId) => updateVoice({ tts, stt: { ...stt, modelId: modelId || null } })}
              options={[
                { value: "", label: t("voice.settings.stt.modelAuto") },
                // Only what is on disk can be chosen; the rest appears
                // disabled with the size, and the download stays right below.
                ...sttModels.map((model) => {
                  const missing = modelOnDisk(model.id) === false && model.id !== stt.modelId
                  return {
                    value: model.id,
                    label: shortModelName(model.label, model.id),
                    title: model.label,
                    disabled: missing,
                    hint: missing
                      ? t("voice.settings.stt.modelNotDownloadedHint", {
                          size: formatSizeMb(model.sizeMb) ?? t("voice.settings.models.sizeUnknown"),
                        })
                      : undefined,
                  }
                }),
              ]}
            />
          )}
        </SettingRow>

        {/* What is in use and what is still to download — explicit, without depending on
            the user guessing the effect of "Automatic". */}
        {status && sttModels.length > 0 && (
          <div className="flex flex-col gap-1.5 px-1 text-[11px] text-muted-foreground">
            {inUseModel ? (
              <>
                <Truncate text={t(
                    inUseAuto ? "voice.settings.stt.modelInUseAuto" : "voice.settings.stt.modelInUse",
                    { model: shortModelName(inUseModel.label, inUseModel.id) },
                  )}>
                  <p className="truncate" >
                    {t(
                      inUseAuto ? "voice.settings.stt.modelInUseAuto" : "voice.settings.stt.modelInUse",
                      { model: shortModelName(inUseModel.label, inUseModel.id) },
                    )}
                  </p>
                </Truncate>
                {inUseMeta && (
                  <Truncate text={inUseMeta}>
                    <p className="truncate" >
                      {inUseMeta}
                    </p>
                  </Truncate>
                )}
                {inUseDownloaded === false && (
                  <div className="flex items-center gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <TriangleAlert className="size-3 shrink-0" />
                      {t("voice.settings.stt.modelNotDownloaded")}
                    </span>
                    <Button
                      size="sm"
                      className="shrink-0 gap-1"
                      onClick={() => startDownload(inUseModel.id)}
                    >
                      <Download className="size-3" />
                      {t("voice.settings.stt.downloadNow", {
                        size: formatSizeMb(inUseModel.sizeMb) ?? t("voice.settings.models.sizeUnknown"),
                      })}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <p>{t("voice.settings.stt.modelNoneSelected")}</p>
            )}
          </div>
        )}

        {/* Shortcut to download another model of the engine without going down to the full
            list: downloaded from here, it is already chosen. */}
        {missingModels.length > 0 && (
          <div className="flex flex-col gap-2 px-1">
            <Button
              size="sm"
              variant="ghost"
              className="w-fit gap-1 px-1.5 text-[11px] text-muted-foreground"
              aria-expanded={showMoreModels}
              onClick={() => setShowMoreModels((open) => !open)}
            >
              <ChevronDown className={showMoreModels ? "size-3 rotate-180" : "size-3"} />
              {t(showMoreModels ? "voice.settings.stt.moreModelsHide" : "voice.settings.stt.moreModels", {
                count: missingModels.length,
              })}
            </Button>
            {showMoreModels && (
              <VoiceModelsSection
                models={missingModels}
                status={status}
                onChanged={refresh}
                onDownloaded={(modelId) => {
                  // Read at the moment the download ends: the preference may have
                  // changed while it was running (another engine, another model).
                  const current = useAppSettings.getState().settings.voice
                  if (!current || current.stt.engine !== stt.engine) return
                  updateVoice({ tts: current.tts, stt: { ...current.stt, modelId } })
                }}
              />
            )}
          </div>
        )}

        <SettingRow
          icon={Languages}
          title={t("voice.settings.stt.langTitle")}
          description={t("voice.settings.stt.langHint")}
        >
          <SettingSelect<string>
            value={stt.language}
            onChange={(language) => updateVoice({ tts, stt: { ...stt, language } })}
            options={STT_LANGS.map((code) => ({ value: code, label: t(`voice.settings.languages.${code}`) }))}
          />
        </SettingRow>

        <SettingRow
          icon={AudioLines}
          title={t("voice.settings.stt.liveTitle")}
          description={t("voice.settings.stt.liveHint")}
        >
          <SettingSwitch
            checked={stt.live}
            onChange={(live) => updateVoice({ tts, stt: { ...stt, live } })}
            label={t("voice.settings.stt.liveTitle")}
          />
        </SettingRow>

        <SettingRow
          icon={Gauge}
          title={t("voice.settings.stt.preloadTitle")}
          description={t("voice.settings.stt.preloadHint")}
        >
          <SettingSwitch
            checked={stt.preload}
            onChange={(preload) => {
              updateVoice({ tts, stt: { ...stt, preload } })
              // Turning it off gives the RAM back RIGHT AWAY: the main process releases the model that was already
              // loaded, instead of waiting for the 5 min idle cycle.
              if (!preload) void voiceApi.sttRelease()
            }}
            label={t("voice.settings.stt.preloadTitle")}
          />
        </SettingRow>

        <SettingRow
          icon={Gauge}
          title={t("voice.settings.stt.threadsTitle")}
          description={t("voice.settings.stt.threadsHint")}
        >
          <SettingSelect<string>
            value={String(stt.threads)}
            onChange={(next) => updateVoice({ tts, stt: { ...stt, threads: Number(next) } })}
            options={threadOptions(hardware?.cpus).map((value) => ({ value, label: value }))}
          />
        </SettingRow>

        {/* What this machine supports: reason, warnings and the next step in
            evidence when the recommended model is not on disk yet. */}
        {hardware && recommendationActive && (
          <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground" title={hardware.reason}>
            <Sparkles className="size-3 shrink-0" />
            {t("voice.settings.stt.recommendActive", {
              engine: engineLabel(hardware.recommendedEngine),
              model: shortModelName(recommendedModelLabel, hardware.recommendedModel),
            })}
          </p>
        )}

        {hardware && !recommendationActive && (
          <div className="mt-1 rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2">
              <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
              <p className="flex-1 text-xs font-medium">{t("voice.settings.stt.recommendTitle")}</p>
            </div>
            <p className="mt-1.5 text-[11px]">
              {t("voice.settings.stt.recommendPick", {
                engine: engineLabel(hardware.recommendedEngine),
                model: recommendedModelLabel,
              })}
            </p>
            {hardware.reason && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("voice.settings.stt.recommendReason", { reason: hardware.reason })}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {/* Without repeating the button the row of the model in use already showed
                  for this same model. */}
              {recommendedDownloaded === false && hardware.recommendedModel !== inUseModel?.id && (
                <Button
                  size="sm"
                  className="gap-1"
                  onClick={() => startDownload(hardware.recommendedModel)}
                >
                  <Download className="size-3" />
                  {t("voice.settings.stt.downloadNow", {
                    size:
                      formatSizeMb(recommendedModel?.sizeMb ?? null) ?? t("voice.settings.models.sizeUnknown"),
                  })}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={applyRecommendation}>
                {t("voice.settings.stt.recommendApply")}
              </Button>
            </div>
            {hardware.warnings?.length > 0 && (
              <div className="mt-2">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <TriangleAlert className="size-3 shrink-0" />
                  {t("voice.settings.stt.recommendWarnings")}
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                  {hardware.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {hardware && (
          <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground/70">
            <Cpu className="size-3 shrink-0" />
            {t("voice.settings.stt.hardwareSummary", {
              platform: hardware.platform,
              arch: hardware.arch,
              cpus: hardware.cpus,
              memory: hardware.totalMemGb,
            })}
          </p>
        )}
      </div>

      {/* ── Call mode ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 border-t pt-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t("voice.settings.sections.call")}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">{t("voice.settings.sections.callHint")}</p>
        </div>

        <SettingRow
          icon={Phone}
          title={t("voice.settings.call.enableTitle")}
          description={t("voice.settings.call.enableHint")}
        >
          <SettingSwitch
            checked={call.enabled}
            onChange={(enabled) => updateVoice({ call: { ...call, enabled } })}
            label={t("voice.settings.call.enableTitle")}
          />
        </SettingRow>

        <SettingRow
          icon={Timer}
          title={t("voice.settings.call.silenceTitle")}
          description={t("voice.settings.call.silenceHint")}
        >
          <SettingSelect<string>
            value={String(call.silenceMs)}
            onChange={(next) => updateVoice({ call: { ...call, silenceMs: Number(next) } })}
            options={VOICE_CALL_SILENCE_OPTIONS.map((ms) => ({
              value: String(ms),
              label: t("voice.settings.call.silenceValue", { seconds: (ms / 1000).toLocaleString() }),
            }))}
          />
        </SettingRow>

        <p className="px-1 text-[11px] text-muted-foreground/70">{t("voice.settings.call.needs")}</p>
      </div>

      {/* ── Models ────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 border-t pt-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t("voice.settings.sections.models")}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">{t("voice.settings.sections.modelsHint")}</p>
        </div>
        {/* With no readable catalog there is no list to show — the error card at the
            top already explains why (better than "no model available"). */}
        {!loadError && <VoiceModelsSection models={models} status={status} onChanged={refresh} />}
      </div>
    </div>
  )
}
