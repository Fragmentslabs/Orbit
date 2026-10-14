import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Download, Loader2, Mic, Timer, Trash2, Volume2 } from "lucide-react"
import type { VoiceDownloadProgress, VoiceModelKind, VoiceStatusSnapshot } from "@shared/voice"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatSizeMb } from "@/src/lib/voice-models"
import { voiceApi } from "@/src/lib/voice-ipc"

/**
 * Modelos do catálogo com o estado de cada um e as ações (baixar, cancelar,
 * remover). O download em si é do main — o que corre aqui é o progresso que
 * ele emite em `voice:download-progress`.
 */

/** Linha do catálogo que a tela mostra: a visão de `src/lib/voice-models` mais
 *  os idiomas, que aparecem como metadado secundário (truncado). */
export interface VoiceModelRow {
  id: string
  label: string
  engine: string
  kind: VoiceModelKind
  sizeMb: number | null
  langs: string[]
}

/**
 * Estado do motor, num lugar só — o selo e o texto saem daqui, então os dois
 * nunca se contradizem:
 *   - `ready`: dá para usar agora;
 *   - `preparing`: os arquivos estão no disco e falta só o preparo do primeiro
 *     uso (a extração do pacote e o VAD Silero do Parakeet);
 *   - `missing`: falta baixar — ou o motor não roda nesta máquina, e aí o
 *     `reason` do main diz qual dos dois é.
 *
 * O main está separando "baixado" de "pronto": quando ele publicar `downloaded`
 * e `ready`, esses campos mandam. Sem eles a conta cai na combinação que o
 * retrato sempre teve — `available` (dá para abrir sessão) e `installed`
 * (nada a preparar) —, e só quem tem os dois está pronto.
 */
export type EnginePhase = "ready" | "preparing" | "missing"

/** O que a fase lê do status do motor (aceita os campos novos, se vierem). */
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
  // Motor que não roda nesta máquina (whisper sem o `whisper-server`, sherpa que
  // não carregou) não tem preparo a oferecer: o "Preparar agora" virava um
  // botão sem efeito. Fica "missing", e o selo/motivo dizem o porquê.
  if (engine.available === false) return "missing"
  // Com os bytes no disco já não é "missing": o que falta é o PREPARO (extração
  // do pacote e VAD) — ou o motor não roda nesta máquina, e aí o `reason` diz
  // exatamente isso. Chamar de "não instalado" o que está baixado era o bug.
  if (downloaded) return "preparing"
  return "missing"
}

/**
 * Nome curto para o seletor: os rótulos do catálogo são frases inteiras
 * ("Whisper large-v3-turbo (whisper.cpp) — 574 MB, …"). Fica o que identifica o
 * modelo; o rótulo completo vai no `title` do controle.
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

/** Fase de um modelo do catálogo: o TTS tem um motor só e o resumo é
 *  `ttsReady`; o STT sai do estado do motor que consome o modelo. */
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
  /** Recarrega catálogo e estado (quando um download termina ou um modelo sai). */
  onChanged: () => void
  /**
   * Um download começado NESTA lista terminou bem. Só os daqui: as duas listas
   * da tela (a rápida, junto do seletor, e a completa) ouvem os mesmos eventos.
   */
  onDownloaded?: (modelId: string) => void
}) {
  const { t } = useTranslation()
  const [progress, setProgress] = useState<Record<string, VoiceDownloadProgress>>({})
  /** Modelo com ação em andamento antes de o primeiro evento de progresso chegar. */
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
        // `started: false` = não havia o que baixar (já está no disco). Sem isto
        // o giro ficaria ligado para sempre, sem evento de progresso que o
        // desligasse — era o clique que "não fazia nada".
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
        // Dois fatos diferentes, e o selo precisa separar os dois: "baixado" são
        // os BYTES no disco; "pronto" é o motor conseguindo usar (o pacote do
        // Parakeet extraído, com o VAD Silero). Sem isso o selo dizia "não
        // baixado" ao lado de um texto dizendo que o pacote já estava baixado.
        const downloaded = modelStatus?.downloaded ?? modelStatus?.installed ?? false
        const ready = modelStatus?.ready ?? modelStatus?.installed ?? false
        const event = progress[model.id]
        const downloading = !!event && !event.done && !event.error
        const size = formatSizeMb(model.sizeMb)
        const Icon = kindIcon(model.kind)
        const percent = event ? percentOf(event) : 0
        const running = downloading || !!busy[model.id]
        const phase = modelPhase(model, downloaded, status)
        // Tamanho e idiomas juntos na linha secundária; sem tamanho conhecido,
        // fica só o que o catálogo informou.
        const meta = [size ?? t("voice.settings.models.sizeUnknown"), model.langs.join(", ")]
          .filter((part) => !!part)
          .join(" · ")
        return (
          <div key={model.id} className="rounded-lg border border-border p-3 transition-colors hover:bg-accent/50">
            <div className="flex items-center gap-2">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium" title={model.label}>
                {shortModelName(model.label, model.id)}
              </span>
              {downloading ? (
                <Button size="sm" variant="outline" onClick={() => cancelDownload(model.id)}>
                  {t("voice.settings.models.cancel")}
                </Button>
              ) : running ? (
                <span className="flex size-6 shrink-0 items-center justify-center">
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                </span>
              ) : downloaded ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="shrink-0"
                  title={t("voice.settings.models.remove")}
                  onClick={() => removeModel(model.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
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
              <span className="min-w-0 truncate" title={meta}>
                {meta}
              </span>
            </div>

            {/* Baixado e ainda não utilizável: o selo (baixado) continua valendo,
                mas o texto diz o que falta — nunca um sem o outro. */}
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
