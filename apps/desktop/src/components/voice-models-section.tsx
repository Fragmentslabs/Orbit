import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Download, Loader2, Mic, Timer, Trash2, Volume2 } from "lucide-react"
import type { VoiceDownloadProgress, VoiceModelKind, VoiceStatusSnapshot } from "@shared/voice"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatSizeMb } from "@/src/lib/voice-models"
import { voiceApi } from "@/src/lib/voice-ipc"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Catalog models with the state of each one and the actions (download, cancel,
 * remove). The download itself belongs to the main process — what runs here is the progress it
 * emits in `voice:download-progress`.
 */

/** Catalog row the screen shows: the `src/lib/voice-models` view plus
 *  the languages, which appear as secondary metadata (truncated). */
export interface VoiceModelRow {
  id: string
  label: string
  engine: string
  kind: VoiceModelKind
  sizeMb: number | null
  langs: string[]
}

/**
 * Engine state, in a single place — the badge and the text come from here, so the two
 * never contradict each other:
 *   - `ready`: it can be used now;
 *   - `preparing`: the files are on disk and only the preparation of the first
 *     use is missing (the package extraction and the Parakeet Silero VAD);
 *   - `missing`: the download is missing — or the engine does not run on this machine, and then the
 *     main process `reason` says which of the two it is.
 *
 * The main process is separating "downloaded" from "ready": when it publishes `downloaded`
 * and `ready`, those fields rule. Without them the count falls into the combination the
 * snapshot always had — `available` (a session can be opened) and `installed`
 * (nothing to prepare) —, and only whoever has both is ready.
 */
export type EnginePhase = "ready" | "preparing" | "missing"

/** What the phase reads from the engine status (it accepts the new fields, if they come). */
export interface EngineStatusLike {
  installed?: boolean
  available?: boolean
  ready?: boolean
  downloaded?: boolean
  reason?: string
}

export function enginePhase(engine: EngineStatusLike | null | undefined, modelDownloaded: boolean): EnginePhase {
  if (!engine) return modelDownloaded ? "preparing" : "missing"
  const downloaded =
    typeof engine.downloaded === "boolean"
      ? engine.downloaded
      : engine.installed === true || engine.available === true || modelDownloaded
  const ready =
    typeof engine.ready === "boolean" ? engine.ready : engine.available === true && engine.installed === true
  if (ready) return "ready"
  // An engine that does not run on this machine (whisper without `whisper-server`, sherpa that
  // did not load) has no preparation to offer: the "Prepare now" became a
  // button with no effect. It stays "missing", and the badge/reason say why.
  if (engine.available === false) return "missing"
  // With the bytes on disk it is no longer "missing": what is missing is the PREPARATION (extraction
  // of the package and VAD) — or the engine does not run on this machine, and then the `reason` says
  // exactly that. Calling "not installed" what is downloaded was the bug.
  if (downloaded) return "preparing"
  return "missing"
}

/**
 * Short name for the selector: the catalog labels are whole sentences
 * ("Whisper large-v3-turbo (whisper.cpp) — 574 MB, …"). What identifies the
 * model stays; the full label goes in the control's `title`.
 */
export function shortModelName(label: string, id: string): string {
  const head = (label || "").split("—")[0]?.replace(/\([^)]*\)\s*$/, "").trim() ?? ""
  return head || id
}

function kindLabelKey(kind: VoiceModelKind): string {
  return kind === "tts" ? "voice.settings.models.kindTts" : "voice.settings.models.kindStt"
}

function kindIcon(kind: VoiceModelKind) {
  return kind === "tts" ? Volume2 : Mic
}

function percentOf(progress: VoiceDownloadProgress): number {
  if (!progress.total || progress.total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((progress.received / progress.total) * 100)))
}

/** Phase of a catalog model: the TTS has a single engine and the summary is
 *  `ttsReady`; the STT comes from the state of the engine that consumes the model. */
function modelPhase(model: VoiceModelRow, downloaded: boolean, status: VoiceStatusSnapshot | null): EnginePhase {
  if (model.kind === "tts") return status?.ttsReady ? "ready" : downloaded ? "preparing" : "missing"
  const engine = status?.engines.find((info) => info.engine === model.engine) ?? null
  return enginePhase(engine, downloaded)
}

export function VoiceModelsSection({
  models,
  status,
  onChanged,
  onDownloaded,
}: {
  models: VoiceModelRow[]
  status: VoiceStatusSnapshot | null
  /** Reloads catalog and state (when a download ends or a model is removed). */
  onChanged: () => void
  /**
   * A download started IN THIS list ended well. Only the ones from here: the two lists
   * of the screen (the quick one, next to the selector, and the full one) hear the same events.
   */
  onDownloaded?: (modelId: string) => void
}) {
  const { t } = useTranslation()
  const [progress, setProgress] = useState<Record<string, VoiceDownloadProgress>>({})
  /** Model with an action in progress before the first progress event arrives. */
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const startedHere = useRef(new Set<string>())
  const onDownloadedRef = useRef(onDownloaded)
  onDownloadedRef.current = onDownloaded

  useEffect(
    () =>
      voiceApi.onDownloadProgress((event) => {
        setProgress((current) => ({ ...current, [event.modelId]: event }))
        setBusy((current) => (current[event.modelId] ? { ...current, [event.modelId]: false } : current))
        if (event.done) {
          if (startedHere.current.delete(event.modelId) && !event.error) onDownloadedRef.current?.(event.modelId)
          onChanged()
        }
      }),
    [onChanged],
  )

  const drop = (modelId: string) =>
    setProgress((current) => {
      if (!(modelId in current)) return current
      const next = { ...current }
      delete next[modelId]
      return next
    })

  const startDownload = (modelId: string) => {
    startedHere.current.add(modelId)
    setBusy((current) => ({ ...current, [modelId]: true }))
    drop(modelId)
    void voiceApi
      .download(modelId)
      .then((result) => {
        // `started: false` = there was nothing to download (it is already on disk). Without this
        // the spinner would stay on forever, with no progress event to
        // turn it off — it was the click that "did nothing".
        if (!(result as { started?: boolean } | undefined)?.started) {
          startedHere.current.delete(modelId)
          setBusy((current) => ({ ...current, [modelId]: false }))
        }
      })
      .catch(() => setBusy((current) => ({ ...current, [modelId]: false })))
  }

  const cancelDownload = (modelId: string) => {
    startedHere.current.delete(modelId)
    drop(modelId)
    setBusy((current) => ({ ...current, [modelId]: false }))
    void voiceApi.cancelDownload(modelId).catch(() => undefined)
  }

  const removeModel = (modelId: string) => {
    setBusy((current) => ({ ...current, [modelId]: true }))
    drop(modelId)
    void voiceApi
      .removeModel(modelId)
      .then(onChanged)
      .catch(() => undefined)
      .finally(() => setBusy((current) => ({ ...current, [modelId]: false })))
  }

  if (models.length === 0) {
    return <p className="py-2 text-center text-xs text-muted-foreground">{t("voice.settings.models.empty")}</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {models.map((model) => {
        const modelStatus = status?.models[model.id]
        // Two different facts, and the badge needs to separate the two: "downloaded" are
        // the BYTES on disk; "ready" is the engine being able to use it (the
        // Parakeet package extracted, with the Silero VAD). Without this the badge said "not
        // downloaded" next to a text saying the package was already downloaded.
        const downloaded = modelStatus?.downloaded ?? modelStatus?.installed ?? false
        const ready = modelStatus?.ready ?? modelStatus?.installed ?? false
        const event = progress[model.id]
        const downloading = !!event && !event.done && !event.error
        const size = formatSizeMb(model.sizeMb)
        const Icon = kindIcon(model.kind)
        const percent = event ? percentOf(event) : 0
        const running = downloading || !!busy[model.id]
        const phase = modelPhase(model, downloaded, status)
        // Size and languages together in the secondary row; without a known size,
        // only what the catalog informed stays.
        const meta = [size ?? t("voice.settings.models.sizeUnknown"), model.langs.join(", ")]
          .filter((part) => !!part)
          .join(" · ")
        return (
          <div key={model.id} className="rounded-lg border border-border p-3 transition-colors hover:bg-accent/50">
            <div className="flex items-center gap-2">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <Truncate text={shortModelName(model.label, model.id)}>
                <span className="min-w-0 flex-1 truncate text-xs font-medium" >
                  {shortModelName(model.label, model.id)}
                </span>
              </Truncate>
              {downloading ? (
                <Button size="sm" variant="outline" onClick={() => cancelDownload(model.id)}>
                  {t("voice.settings.models.cancel")}
                </Button>
              ) : running ? (
                <span className="flex size-6 shrink-0 items-center justify-center">
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                </span>
              ) : downloaded ? (
                <Hint label={t("voice.settings.models.remove")}>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="shrink-0"

                    onClick={() => removeModel(model.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </Hint>
              ) : (
                <Button size="sm" variant="outline" className="shrink-0 gap-1" onClick={() => startDownload(model.id)}>
                  <Download className="size-3" />
                  {t("voice.settings.models.download")}
                </Button>
              )}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <Badge variant={downloaded ? "secondary" : "outline"} className="shrink-0 text-[10px]">
                {downloaded ? t("voice.settings.models.installed") : t("voice.settings.models.notInstalled")}
              </Badge>
              <Badge variant="ghost" className="shrink-0 text-[10px] text-muted-foreground">
                {t(kindLabelKey(model.kind))}
              </Badge>
              <Truncate text={meta}>
                <span className="min-w-0 truncate" >
                  {meta}
                </span>
              </Truncate>
            </div>

            {/* Downloaded and not usable yet: the badge (downloaded) keeps counting,
                but the text says what is missing — never one without the other. */}
            {downloaded && !ready && phase === "preparing" && (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Timer className="size-3 shrink-0" />
                {t("voice.settings.models.preparing")}
              </p>
            )}

            {downloading && (
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {t("voice.settings.models.downloading", { percent })}
                </span>
              </div>
            )}

            {event?.error && (
              <p className="mt-1 text-[11px] text-destructive">
                {t("voice.settings.models.failedWith", { error: event.error })}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
