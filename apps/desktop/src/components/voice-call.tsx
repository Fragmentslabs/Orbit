import { useCallback, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { AudioLines, Hand, Phone, PhoneOff } from "lucide-react"
import type { WorkspaceMode } from "@/lib/workspace-context"
import { DictationWave } from "@/src/components/dictation-wave"
import { useVoiceCallHost } from "@/src/components/voice-call-host"
import { useVoiceStatus } from "@/src/hooks/use-speak"
import { useVoiceCall } from "@/src/hooks/use-voice-call"
import { dictationSupported, resolveVoiceSttSettings, voiceTargetReady } from "@/src/lib/dictation"
import { isCallOwner } from "@/src/lib/voice-call"
import { useAppSettings } from "@/src/stores/app-settings"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useVoiceActivity } from "@/src/stores/voice-activity"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/** Quanto o aviso de erro fica à vista depois de a chamada cair. */
const ERROR_VISIBLE_MS = 6000

/** O que os dois controles precisam saber sobre o motor de voz antes de
 *  oferecer a chamada. */
function useVoiceCallSetup() {
  const settings = useAppSettings((s) => s.settings)
  const callEnabled = (settings as unknown as { voice?: { call?: { enabled?: boolean } } }).voice?.call?.enabled ?? true
  const stt = resolveVoiceSttSettings(settings)
  const { status } = useVoiceStatus(callEnabled && stt.enabled)
  const ready = voiceTargetReady(status, stt.engine, stt.modelId)
  const openSettings = useSettingsUi((s) => s.openSettings)
  // Ditado comum gravando: o microfone está ocupado, então a chamada não é
  // oferecida até o ditado acabar (o slot volta a ser o "Enviar").
  const dictating = useVoiceActivity((s) => s.listening && !s.inCall)
  const available = callEnabled && stt.enabled && dictationSupported()
  return { callEnabled, sttEnabled: stt.enabled, ready, openSettings, dictating, available }
}

/**
 * Controle local, usado pelo overlay: ele tem a própria sessão e a própria
 * janela, fora do host da janela principal.
 */
export function useVoiceCallControl({ sessionId, submit }: { sessionId?: string; submit: (text: string) => boolean }) {
  const setup = useVoiceCallSetup()
  const { ready, openSettings, available, dictating, callEnabled, sttEnabled } = setup
  const call = useVoiceCall({ sessionId, submit })
  const { error, dismissError, active, hangUp, start: startCall } = call

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(dismissError, ERROR_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [error, dismissError])

  // Desligaram a chamada (ou o ditado) nas preferências no meio dela: encerra.
  useEffect(() => {
    if (active && (!callEnabled || !sttEnabled)) hangUp()
  }, [active, callEnabled, sttEnabled, hangUp])

  const start = useCallback(() => {
    if (!ready) {
      openSettings("voice")
      return
    }
    startCall()
  }, [ready, openSettings, startCall])

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
 * Controle da janela principal: lê a chamada do host global e só mostra o
 * painel na conversa dona dela. Nas outras, o botão de ligação fica bloqueado
 * e leva para a chamada em curso.
 */
export function useHostedVoiceCallControl({
  sessionId,
  mode,
  submit,
  createCallSession,
}: {
  sessionId?: string
  mode: WorkspaceMode
  submit: (text: string) => boolean
  /**
   * Chamada a partir de um chat novo: cria (e seleciona) a sessão que vai ser
   * dona da chamada. Sem isso o submit teria `sessionId` undefined e o
   * `sendMessage` cairia na sessão ativa — o chat que estiver aberto.
   */
  createCallSession?: () => Promise<{ sessionId: string; submit?: (text: string) => boolean } | undefined>
}) {
  const setup = useVoiceCallSetup()
  const { ready, openSettings, available, dictating, callEnabled, sttEnabled } = setup
  const host = useVoiceCallHost()
  const call = host.call
  const { active: callActive, hangUp } = call
  const { openCall, start: startCall } = host
  const isCallSession = isCallOwner({ callSessionId: host.callSessionId, sessionId })
  const elsewhere = callActive && !isCallSession
  const startingRef = useRef(false)

  // O host confere a sessão: este composer só consegue registrar se ESTA
  // conversa for a dona da chamada.
  const hostRegisterSubmit = host.registerSubmit
  const registerSubmit = useCallback(
    (submit: (text: string) => boolean) => hostRegisterSubmit(sessionId, submit),
    [hostRegisterSubmit, sessionId],
  )

  // Desligaram a chamada (ou o ditado) nas preferências: encerra em qualquer
  // chat, não só no que está com o painel à vista.
  useEffect(() => {
    if (callActive && (!callEnabled || !sttEnabled)) hangUp()
  }, [callActive, callEnabled, sttEnabled, hangUp])

  const start = useCallback(() => {
    if (startingRef.current) return
    void (async () => {
      startingRef.current = true
      try {
        if (elsewhere) {
          openCall()
          return
        }
        if (!ready) {
          openSettings("voice")
          return
        }
        if (sessionId) {
          startCall(sessionId, mode, submit)
          return
        }
        // Chat novo: a sessão nasce AGORA e a chamada já começa presa a ela.
        // É o que impede o primeiro turno de cair no chat que estiver aberto.
        const created = await createCallSession?.()
        if (!created) return
        startCall(created.sessionId, mode, created.submit ?? submit)
      } catch {
        // A chamada simplesmente não começa; o composer segue normal.
      } finally {
        startingRef.current = false
      }
    })()
  }, [elsewhere, openCall, startCall, sessionId, mode, submit, createCallSession, ready, openSettings])

  return {
    call,
    ready,
    start,
    /** O botão da chamada no slot vazio (bloqueado quando a chamada é de outra conversa). */
    inSlot: callActive || (available && !dictating),
    /** Esta conversa é a dona da chamada. */
    isCallSession,
    /** A chamada está em outra conversa. */
    elsewhere,
    openCall,
    callSessionTitle: host.callSessionTitle,
    registerSubmit,
  }
}

export type HostedVoiceCallControlState = ReturnType<typeof useHostedVoiceCallControl>

/**
 * O botão da chamada no lugar do "Enviar" (campo vazio): fora da chamada ela
 * começa; durante, vira o "desligar". Sem o motor de ditado pronto leva às
 * Preferências na aba de voz.
 */
export function VoiceCallButton({ control }: { control: HostedVoiceCallControlState }) {
  const { t } = useTranslation()
  const { call, ready, start } = control
  if (control.isCallSession && call.active) {
    return (
      <Hint label={t("voice.call.hangUp")}>
        <button
          type="button"
          aria-label={t("voice.call.hangUp")}

          onClick={call.hangUp}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive text-white transition-colors hover:bg-destructive/90"
        >
          <PhoneOff className="size-4" />
        </button>
      </Hint>
    )
  }
  // Chamada em outra conversa: o botão não começa outra — explica onde ela
  // está e leva para lá.
  if (control.elsewhere) {
    const label = control.callSessionTitle
      ? t("voice.call.elsewhere", { title: control.callSessionTitle })
      : t("voice.call.elsewhereOther")
    return (
      <Hint label={label}>
        <button
          type="button"
          aria-label={label}

          onClick={start}
          className="relative flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Phone className="size-4 opacity-50" />
          <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
        </button>
      </Hint>
    )
  }
  const label = ready ? t("voice.call.start") : t("voice.call.setup")
  return (
    <Hint label={label}>
      <button
        type="button"
        aria-label={label}

        onClick={start}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/85"
      >
        <AudioLines className="size-4" />
      </button>
    </Hint>
  )
}

/**
 * As duas linhas da legenda da chamada: a de cima é a que está sendo dita
 * (branca) e a de baixo é a próxima (cinza). Quando a fala avança, a trilha
 * sobe uma linha — a próxima assume o lugar da atual e uma nova entra embaixo.
 */
export function CallCaption({ lines, current }: { lines: string[]; current: number }) {
  const at = Math.max(0, Math.min(current, lines.length - 1))
  return (
    <div className="h-[2.75em] min-w-0 flex-1 overflow-hidden text-xs leading-snug">
      <div
        className="transition-transform duration-200 ease-out"
        // 1.375em = leading-snug: a trilha sobe exatamente uma linha por vez.
        style={{ transform: `translateY(-${(at * 1.375).toFixed(3)}em)` }}
      >
        {lines.map((line, index) => (
          <Truncate text={line}>
            <div
              key={index}
              aria-hidden={index === at ? undefined : true}
              className={cn(
                "h-[1.375em] truncate transition-colors duration-200",
                index === at ? "text-foreground" : "text-muted-foreground/40",
              )}
            >
              {line}
            </div>
          </Truncate>
        ))}
      </div>
    </div>
  )
}

/**
 * Painel da chamada no topo do campo (cobre o texto): a fase (ouvindo /
 * pensando / falando), a legenda em duas linhas — a que está sendo dita em
 * branco e a próxima em cinza — e o "interromper". Fora da chamada mostra só
 * o aviso de uma chamada que caiu.
 */
export function VoiceCallPanel({ control }: { control: HostedVoiceCallControlState }) {
  const { t } = useTranslation()
  const { call } = control
  const errorText = call.error === "reply" ? t("voice.call.replyError") : call.error

  // O painel é da conversa dona da chamada. As outras seguem com o composer
  // normal; o card flutuante e o botão bloqueado levam até ela.
  if (!control.isCallSession) return null

  if (!call.active) {
    if (!errorText) return null
    return (
      <Truncate>
          <span role="status" title={errorText} className="max-w-56 truncate text-xs text-destructive">
          {t("voice.call.failed")} {errorText}
        </span>
      </Truncate>
    )
  }

  const { phase } = call
  const caption = phase === "speaking" ? call.caption : null
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
      ) : caption ? (
        <CallCaption lines={caption.lines} current={caption.current} />
      ) : (
        // Fora da fala (ouvindo/pensando) a prévia cresce ancorada EMBAIXO: o
        // texto novo fica à vista e o antigo sobe e some no topo.
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
