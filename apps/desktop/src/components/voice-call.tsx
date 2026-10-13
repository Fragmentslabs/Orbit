import { useCallback, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { AudioLines, Hand, PhoneOff } from "lucide-react"
import { DictationWave } from "@/src/components/dictation-wave"
import { useVoiceStatus } from "@/src/hooks/use-speak"
import { useVoiceCall } from "@/src/hooks/use-voice-call"
import { dictationSupported, resolveVoiceSttSettings, voiceTargetReady } from "@/src/lib/dictation"
import { useAppSettings } from "@/src/stores/app-settings"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useVoiceActivity } from "@/src/stores/voice-activity"
import { cn } from "@/lib/utils"

/** Quanto o aviso de erro fica à vista depois de a chamada cair. */
const ERROR_VISIBLE_MS = 6000

/**
 * Estado do modo chamada para um input: o hook da chamada mais as regras de
 * quando ela aparece. Vive no INPUT (não num botão) porque a chamada tem duas
 * peças em lugares diferentes do campo: o botão no lugar do "Enviar"
 * (`VoiceCallButton`) e o painel no topo (`VoiceCallPanel`).
 */
export function useVoiceCallControl({ sessionId, submit }: { sessionId?: string; submit: (text: string) => boolean }) {
  const settings = useAppSettings((s) => s.settings)
  const callEnabled = (settings as unknown as { voice?: { call?: { enabled?: boolean } } }).voice?.call?.enabled ?? true
  const stt = resolveVoiceSttSettings(settings)
  const { status } = useVoiceStatus(callEnabled && stt.enabled)
  const ready = voiceTargetReady(status, stt.engine, stt.modelId)
  const openSettings = useSettingsUi((s) => s.openSettings)
  const call = useVoiceCall({ sessionId, submit })
  const { error, dismissError, active, hangUp } = call
  // Ditado comum gravando: o microfone está ocupado, então a chamada não é
  // oferecida até o ditado acabar (o slot volta a ser o "Enviar").
  const dictating = useVoiceActivity((s) => s.listening && !s.inCall)

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(dismissError, ERROR_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [error, dismissError])

  // Desligaram a chamada (ou o ditado) nas preferências no meio dela: encerra.
  useEffect(() => {
    if (active && (!callEnabled || !stt.enabled)) hangUp()
  }, [active, callEnabled, stt.enabled, hangUp])

  const start = useCallback(() => {
    if (!ready) {
      openSettings("voice")
      return
    }
    call.start()
  }, [ready, openSettings, call])

  const available = callEnabled && stt.enabled && dictationSupported()
  return {
    call,
    ready,
    start,
    /** O slot do "Enviar" mostra a chamada (o botão, ou o "desligar" durante ela). */
    inSlot: active || (available && !dictating),
  }
}

export type VoiceCallControlState = ReturnType<typeof useVoiceCallControl>

/**
 * O botão da chamada no lugar do "Enviar" (campo vazio): fora da chamada ela
 * começa; durante, vira o "desligar". Sem o motor de ditado pronto leva às
 * Preferências na aba de voz.
 */
export function VoiceCallButton({ control }: { control: VoiceCallControlState }) {
  const { t } = useTranslation()
  const { call, ready, start } = control
  if (call.active) {
    return (
      <button
        type="button"
        aria-label={t("voice.call.hangUp")}
        title={t("voice.call.hangUp")}
        onClick={call.hangUp}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive text-white transition-colors hover:bg-destructive/90"
      >
        <PhoneOff className="size-4" />
      </button>
    )
  }
  const label = ready ? t("voice.call.start") : t("voice.call.setup")
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={start}
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/85"
    >
      <AudioLines className="size-4" />
    </button>
  )
}

/**
 * Painel da chamada no topo do campo (cobre o texto): a fase (ouvindo /
 * pensando / falando), a prévia do que se diz e o "interromper". Fora da
 * chamada mostra só o aviso de uma chamada que caiu.
 */
export function VoiceCallPanel({ control }: { control: VoiceCallControlState }) {
  const { t } = useTranslation()
  const { call } = control
  const errorText = call.error === "reply" ? t("voice.call.replyError") : call.error

  if (!call.active) {
    if (!errorText) return null
    return (
      <span role="status" title={errorText} className="max-w-56 truncate text-xs text-destructive">
        {t("voice.call.failed")} {errorText}
      </span>
    )
  }

  const { phase } = call
  const text = phase === "listening" ? call.partial : phase === "thinking" ? call.heard : call.saying
  const placeholder =
    phase === "listening" ? t("voice.call.listening") : phase === "thinking" ? t("voice.call.thinking") : t("voice.call.speaking")

  return (
    // Fundo opaco: cobre o texto do campo enquanto a chamada está aberta. Sem o
    // microfone (fora de cena na chamada), ocupa a linha toda.
    <div aria-live="polite" className="flex min-h-7 w-[calc(100cqw-1.25rem)] items-center gap-2 rounded-md bg-background px-1.5">
      <span
        className={cn(
          "flex shrink-0 items-center",
          phase === "speaking" && !call.waiting ? "text-primary" : "text-muted-foreground",
        )}
      >
        {phase === "listening" ? (
          <DictationWave levels={call.levels} className="w-20 bg-transparent px-0" />
        ) : (
          <span aria-hidden className="voice-gen-bars">
            <span />
            <span />
            <span />
          </span>
        )}
      </span>
      {/* Erro no meio da chamada (o agente não respondeu): aparece no lugar da
          prévia até a pessoa voltar a falar, e a chamada segue ouvindo. */}
      {errorText && !text ? (
        <span role="status" className="line-clamp-2 min-w-0 flex-1 text-xs leading-snug text-destructive">
          {errorText}
        </span>
      ) : (
        // Duas linhas ancoradas EMBAIXO: o texto novo (a prévia que cresce, a
        // frase que está tocando) fica à vista e o antigo sobe e some no topo.
        <div
          title={text || placeholder}
          className={cn(
            "flex max-h-[2.75em] min-w-0 flex-1 flex-col justify-end overflow-hidden text-xs leading-snug",
            text.length > 110 && "[mask-image:linear-gradient(to_bottom,transparent,black_45%)]",
          )}
        >
          <span
            className={
              !text
                ? "text-muted-foreground"
                : phase === "thinking" || call.waiting
                  ? "text-muted-foreground italic"
                  : "text-foreground"
            }
          >
            {text || placeholder}
          </span>
        </div>
      )}
      {phase !== "listening" && (
        <button
          type="button"
          onClick={call.interrupt}
          title={t("voice.call.interrupt")}
          aria-label={t("voice.call.interrupt")}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Hand className="size-3.5" />
          {t("voice.call.interruptShort")}
        </button>
      )}
    </div>
  )
}
