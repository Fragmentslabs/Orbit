import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AudioLines,
  Check,
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
import { useAppSettings } from "@/src/stores/app-settings"
import { formatSizeMb, modelViews } from "@/src/lib/voice-models"
import { voiceApi } from "@/src/lib/voice-ipc"

/**
 * Preferências → Voz: TTS (ler respostas em voz alta), STT (ditar) e o
 * gerenciamento dos modelos baixados, com a recomendação para esta máquina.
 *
 * As preferências são o bloco `voice` do AppSettings, que o renderer guarda e
 * persiste — lido com os padrões de `@shared/voice` como rede de segurança
 * para uma versão antiga salva no localStorage.
 *
 * Regra da casa: o selo (Badge) e o texto logo abaixo saem do MESMO estado
 * (ver `enginePhase`). Selo dizendo "não baixado" com texto dizendo "o pacote
 * está no disco" é o defeito que esta tela não pode repetir.
 */

/** Motores de transcrição oferecidos; o Parakeet é o preferido. */
const STT_ENGINES: readonly VoiceEngineId[] = ["parakeet", "whisper"]

/** Vozes do TTS: F1–F5 femininas, M1–M5 masculinas (Supertonic 3). */
const VOICE_IDS = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"] as const

/** Idiomas da leitura; `na` deixa a voz sem idioma (agnóstica). */
const TTS_LANGS = ["pt", "en", "es", "fr", "de", "it", "na"] as const

/** Idiomas do ditado ("auto" deixa o motor detectar). */
const STT_LANGS = ["auto", "pt", "en", "es", "fr", "de", "it", "ja", "zh"] as const

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

/** Threads de inferência oferecidas — o teto é o mesmo do núcleo compartilhado. */
const THREAD_STEPS = [1, 2, 3, 4, 6, 8, 12, 16] as const

/** Catálogo do main nas linhas da tela: a visão de `modelViews` mais os
 *  idiomas, que os metadados mostram como texto secundário. */
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
  // Mescla com o que já está salvo: quem mexe em `tts`/`stt` não apaga o
  // bloco `call` (nem o contrário).
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
  /** Texto completo (o rótulo cortado do catálogo) para o `title`. */
  title?: string
}

/**
 * Select de largura FIXA dentro da linha do painel — o `w-fit` do trigger é
 * sobrescrito com `w-44!` e o rótulo corta com reticências. Os rótulos do
 * catálogo de voz são frases inteiras ("Whisper large-v3-turbo (whisper.cpp) —
 * 574 MB, …"): sem o corte, o controle estica e empurra a linha do grid (o
 * mesmo defeito de layout para "parakeet-tdt-0.6b-v3"). O texto completo fica
 * no `title`; o tamanho e os idiomas, na linha secundária abaixo.
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
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? value}</span>
      </SelectTrigger>
      <SelectContent className="w-56!">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} title={option.title ?? option.label}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Selo do estado do motor — os três estados saem de `EnginePhase`. */
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

  const models = useMemo(() => catalogRows(catalog), [catalog])

  const refresh = useCallback(async () => {
    try {
      const [report, list, state] = await Promise.all([voiceApi.hardware(), voiceApi.models(), voiceApi.status()])
      setHardware(report)
      setCatalog(Array.isArray(list) ? list : null)
      setStatus(state && typeof state === "object" ? state : null)
      setLoadError(false)
    } catch {
      // Canal não registrado (main antigo, dev) ou resposta inválida: o painel
      // mostra um erro legível e continua com o que já tem — nunca uma tela vazia.
      setLoadError(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // O main avisa a cada mudança de estado (download, extração do pacote, VAD,
  // remoção, falha) e a tela reconsulta. Sem esta assinatura o "Preparar agora"
  // parecia não ter função: a extração rodava no main e o selo ficava em
  // "Preparando…" para sempre, mesmo depois de o modelo ficar pronto.
  useEffect(() => voiceApi.onStatusChanged(() => void refresh()), [refresh])

  const engineLabel = useCallback(
    (engine: string): string => {
      if (engine === "parakeet") return t("voice.settings.stt.engineParakeet")
      if (engine === "whisper") return t("voice.settings.stt.engineWhisper")
      return engine
    },
    [t],
  )

  /** `null` = não sabemos (status indisponível, ou o id fora do retrato) —
   *  que NÃO é o mesmo que "não baixado": sem saber, a tela não afirma nada. */
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

  // O estado do motor em UM lugar: o selo e o texto abaixo são consequência dele.
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

  // Modelo "em uso": o escolhido; sem escolha, o que o hardware recomenda e,
  // na falta dele, o primeiro que já está no disco.
  const inUseModel =
    selectedModel ??
    (hardware?.recommendedModel ? sttModels.find((model) => model.id === hardware.recommendedModel) ?? null : null) ??
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
  const engineModelId = selectedModel?.id ?? sttModels[0]?.id ?? null
  const ttsModel = models.find((model) => model.kind === "tts") ?? null
  const ttsDownloaded = downloadedOf(ttsModel?.id ?? null)
  const ttsPhase: EnginePhase = status?.ttsReady ? "ready" : ttsDownloaded ? "preparing" : "missing"

  // Prioridade de áudio: a rota do MODELO (provedor) e o motor LOCAL são as
  // duas metades do estado. "Modelo de voz" fala pelo provedor quando a rota
  // existe; sem ela o pipeline cai no local, e o texto abaixo diz exatamente
  // isso — nada de um selo "pronto" que não corresponde a quem vai falar.
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

      {/* Estado ilegível (canal ausente, main antigo, resposta inválida): um
          cartão com o motivo e o botão de tentar de novo — nunca tela vazia. */}
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

      {/* ── Texto em fala ─────────────────────────────────────────────────── */}
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

        {/* Prioridade de áudio: por onde a fala sai. Compacto, no mesmo padrão
            do seletor de motor do ditado — a linha do grid não estica. */}
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
            {/* Ouvir antes de escolher: a amostra sai pelo mesmo caminho da leitura. */}
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

        {/* Texto do MESMO estado que decide a fala: com a rota do modelo, o
            "pronto" é dela; sem ela, o pipeline usa o motor local e a frase
            nomeia o motivo — baixado ≠ pronto, e a fase manda na frase. */}
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

        {/* Por que a fala NÃO sai pelo modelo: a preferência pede o provedor,
            não há rota, e é o motor local que vai falar. */}
        {tts.enabled && status && tts.engine === "model" && !modelRouteReady && (
          <p className="px-1 text-[11px] text-muted-foreground/70">
            {t("voice.settings.tts.engineModelFallback", { reason: modelTts?.reason ?? "" })}
          </p>
        )}
      </div>

      {/* ── Fala em texto ─────────────────────────────────────────────────── */}
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

        {/* Selo e explicação do MESMO estado: em "preparando" o texto é o que
            falta (extração + VAD), junto da ação de disparar o preparo. */}
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
                ...sttModels.map((model) => ({
                  value: model.id,
                  label: shortModelName(model.label, model.id),
                  title: model.label,
                })),
              ]}
            />
          )}
        </SettingRow>

        {/* O que está em uso e o que falta baixar — explícito, sem depender de
            o usuário adivinhar o efeito do "Automático". */}
        {status && sttModels.length > 0 && (
          <div className="flex flex-col gap-1.5 px-1 text-[11px] text-muted-foreground">
            {inUseModel ? (
              <>
                <p className="truncate" title={inUseModel.label}>
                  {t(
                    inUseAuto ? "voice.settings.stt.modelInUseAuto" : "voice.settings.stt.modelInUse",
                    { model: shortModelName(inUseModel.label, inUseModel.id) },
                  )}
                </p>
                {inUseMeta && (
                  <p className="truncate" title={inUseMeta}>
                    {inUseMeta}
                  </p>
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
              // Desligar devolve a RAM NA HORA: o main solta o modelo que já
              // estava carregado, em vez de esperar o ciclo ocioso de 5 min.
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

        {/* O que esta máquina comporta: motivo, avisos e o próximo passo em
            destaque quando o modelo recomendado ainda não está no disco. */}
        {hardware && (
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
              {/* Sem repetir o botão que a linha do modelo em uso já mostrou
                  para este mesmo modelo. */}
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

      {/* ── Modo chamada ──────────────────────────────────────────────────── */}
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

      {/* ── Modelos ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 border-t pt-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t("voice.settings.sections.models")}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">{t("voice.settings.sections.modelsHint")}</p>
        </div>
        {/* Sem catálogo legível não há lista a mostrar — o cartão de erro no
            topo já explica o porquê (melhor que "nenhum modelo disponível"). */}
        {!loadError && <VoiceModelsSection models={models} status={status} onChanged={refresh} />}
      </div>
    </div>
  )
}
