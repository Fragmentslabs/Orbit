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

/** How long the error notice stays in view after the call drops. */
const ERROR_VISIBLE_MS = 6000

/** What the two controls need to know about the voice engine before
 *  offering the call. */
function useVoiceCallSetup() {
  const settings = useAppSettings((s) => s.settings)
  const callEnabled = (settings as unknown as { voice?: { call?: { enabled?: boolean } } }).voice?.call?.enabled ?? true
  const stt = resolveVoiceSttSettings(settings)
  const { status } = useVoiceStatus(callEnabled && stt.enabled)
  const ready = voiceTargetReady(status, stt.engine, stt.modelId)
  const openSettings = useSettingsUi((s) => s.openSettings)
  // Common dictation recording: the microphone is busy, so the call is not
  // offered until the dictation ends (the slot goes back to being "Send").
  const dictating = useVoiceActivity((s) => s.listening && !s.inCall)
  const available = callEnabled && stt.enabled && dictationSupported()
  return { callEnabled, sttEnabled: stt.enabled, ready, openSettings, dictating, available }
}

/**
 * Local control, used by the overlay: it has its own session and its own
 * window, outside the main window host.
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

  // They turned the call (or the dictation) off in the preferences in the middle of it: it ends.
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
    /** The "Send" slot shows the call (the button, or the "hang up" during it). */
    inSlot: active || (available && !dictating),
  }
}

export type VoiceCallControlState = ReturnType<typeof useVoiceCallControl>

/**
 * Main window control: it reads the call from the global host and only shows the
 * panel in the conversation that owns it. In the others, the call button stays blocked
 * and leads to the call in progress.
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
   * Call from a new chat: it creates (and selects) the session that is going to be
   * the owner of the call. Without that the submit would have `sessionId` undefined and the
   * `sendMessage` would fall into the active session — the chat that happens to be open.
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

  // The host checks the session: this composer can only register if THIS
  // conversation is the owner of the call.
  const hostRegisterSubmit = host.registerSubmit
  const registerSubmit = useCallback(
    (submit: (text: string) => boolean) => hostRegisterSubmit(sessionId, submit),
    [hostRegisterSubmit, sessionId],
  )

  // They turned the call (or the dictation) off in the preferences: it ends in any
  // chat, not only in the one with the panel in view.
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
        // New chat: the session is born NOW and the call already starts tied to it.
        // It is what prevents the first turn from falling into the chat that happens to be open.
        const created = await createCallSession?.()
        if (!created) return
        startCall(created.sessionId, mode, created.submit ?? submit)
      } catch {
        // The call simply does not start; the composer goes on normally.
      } finally {
        startingRef.current = false
      }
    })()
  }, [elsewhere, openCall, startCall, sessionId, mode, submit, createCallSession, ready, openSettings])

  return {
    call,
    ready,
    start,
    /** The call button in the empty slot (blocked when the call belongs to another conversation). */
    inSlot: callActive || (available && !dictating),
    /** This conversation owns the call. */
    isCallSession,
    /** The call is in another conversation. */
    elsewhere,
    openCall,
    callSessionTitle: host.callSessionTitle,
    registerSubmit,
  }
}

export type HostedVoiceCallControlState = ReturnType<typeof useHostedVoiceCallControl>

/**
 * The call button in place of "Send" (empty field): outside the call it
 * starts it; during it, it becomes the "hang up". Without the dictation engine ready it leads to
 * Preferences on the voice tab.
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
  // Call in another conversation: the button does not start another one — it explains where it
  // is and leads there.
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
 * The two caption lines of the call: the top one is what is being said
 * (white) and the bottom one is the next (gray). When the speech advances, the track
 * goes up one line — the next one takes the place of the current and a new one enters below.
 */
export function CallCaption({ lines, current }: { lines: string[]; current: number }) {
  const at = Math.max(0, Math.min(current, lines.length - 1))
  return (
    <div className="h-[2.75em] min-w-0 flex-1 overflow-hidden text-xs leading-snug">
      <div
        className="transition-transform duration-200 ease-out"
        // 1.375em = leading-snug: the track goes up exactly one line at a time.
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
 * Call panel at the top of the field (it covers the text): the phase (listening /
 * thinking / speaking), the caption in two lines — the one being said in
 * white and the next in gray — and the "interrupt". Outside the call it shows only
 * the notice of a call that dropped.
 */
export function VoiceCallPanel({ control }: { control: HostedVoiceCallControlState }) {
  const { t } = useTranslation()
  const { call } = control
  const errorText = call.error === "reply" ? t("voice.call.replyError") : call.error

  // The panel belongs to the conversation that owns the call. The others go on with the normal
  // composer; the floating card and the blocked button lead to it.
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
    // Opaque background: it covers the field text while the call is open. Without the
    // microphone (out of the scene in the call), it takes the whole row.
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
      {/* Error in the middle of the call (the agent did not answer): it appears in place of the
          preview until the person speaks again, and the call keeps listening. */}
      {errorText && !text ? (
        <span role="status" className="line-clamp-2 min-w-0 flex-1 text-xs leading-snug text-destructive">
          {errorText}
        </span>
      ) : caption ? (
        <CallCaption lines={caption.lines} current={caption.current} />
      ) : (
        // Outside the speech (listening/thinking) the preview grows anchored at the BOTTOM: the
        // new text stays in view and the old one goes up and disappears at the top.
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
