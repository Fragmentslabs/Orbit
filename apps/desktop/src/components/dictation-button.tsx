import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Mic } from "lucide-react"
import { usePromptInputController } from "@/src/components/ai/prompt-input"
import { DictationWave, type WaveLevels } from "@/src/components/dictation-wave"
import { useDictation } from "@/src/hooks/use-dictation"
import {
  appendDictation,
  dictationSupported,
  parseVoiceStatus,
  resolveVoiceSttSettings,
  voiceTargetReady,
  type VoiceStatus,
} from "@/src/lib/dictation"
import { voiceApi } from "@/src/lib/voice-ipc"
import { readTtsEngine } from "@/src/hooks/use-speak"
import { useAppSettings } from "@/src/stores/app-settings"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionModel } from "@/src/stores/session-model-prefs"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useVoiceActivity } from "@/src/stores/voice-activity"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Does the AI model accept AUDIO on the input? Only that authorizes dictation through the model —
 * the field format varies (list of modalities or `{ input, output }`), so the
 * reading accepts both forms.
 */
function modelAcceptsAudio(model: unknown): boolean {
  const modalities = (model as { modalities?: unknown } | undefined)?.modalities
  if (Array.isArray(modalities)) return modalities.includes("audio")
  const input = (modalities as { input?: unknown } | undefined)?.input
  return Array.isArray(input) && input.includes("audio")
}

/**
 * Dictation button of the input: **hold to talk, release to transcribe**.
 *
 * The text falls into the SAME state as the input (the PromptInput controller) — it is what
 * the textarea shows and what the chat draft persists —, and always added to
 * what the person had already typed, never over it. With the `live` preference
 * on the provisional text of the engine appears in the field while one speaks; without
 * `live` it stays in a discreet line next to the button itself.
 *
 * Without the dictation model/engine ready the button does not go dead: it stays visible
 * and clicking (or Space/Enter) opens Preferences on the voice tab, where the
 * download happens.
 */
/** Below this the release counts as a tap (turns on hands-free), not "holding". */
const TAP_MS = 300

export function DictationButton({ className, sessionId }: { className?: string; sessionId?: string }) {
  const { t } = useTranslation()
  const controller = usePromptInputController()
  // Chat AI model: with the audio priority at "model" it is the other
  // possible target of the dictation (the audio would go to it instead of the disk engine).
  const selected = useSessionModel(sessionId)
  const catalog = useProviderStore((s) => s.catalog)
  const model = selected ? catalog[selected.providerId]?.models[selected.modelId] : undefined
  // Same preference that rules speech (voice.tts.engine): a single audio
  // priority, for both directions.
  const audioPriority = useAppSettings((s) =>
    readTtsEngine((s.settings as unknown as { voice?: unknown }).voice),
  )
  // `live` is read here (and not from the hook's return) because the callbacks below
  // need it BEFORE the hook exists.
  const live = useAppSettings((s) => resolveVoiceSttSettings(s.settings).live)
  const openSettings = useSettingsUi((s) => s.openSettings)
  // The voice tab is where the model is downloaded: closing it is the signal to re-evaluate
  // the state of the target (there is no reactive voice status event yet).
  const settingsOpen = useSettingsUi((s) => s.open)
  // In a call, it is the one that uses the microphone: the dictation button leaves the scene.
  const inCall = useVoiceActivity((s) => s.inCall)
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [partial, setPartial] = useState("")
  // Input text when the dictation starts and the last value WE wrote:
  // together, they make it possible not to overwrite what the user types in the middle of the speech.
  const baseRef = useRef("")
  const appliedRef = useRef("")
  const pressedRef = useRef(false)
  // Quick tap = hands-free: the microphone stays open until the next click.
  // Holding is still "hold to talk". Without this, a click opened and
  // closed the capture in the same gesture (the persona blinked and nothing was transcribed).
  const pressAtRef = useRef(0)
  const latchedRef = useRef(false)
  const [latched, setLatched] = useState(false)
  // The press that ends hands-free mode: releasing it does nothing anymore.
  const releaseHandledRef = useRef(false)
  const aliveRef = useRef(true)

  const handlePartial = useCallback(
    (text: string) => {
      setPartial(text)
      if (!live) return
      const current = controller.textInput.value
      // The user typed during the speech: it re-anchors on what they wrote.
      if (current !== appliedRef.current) baseRef.current = current
      const next = appendDictation(baseRef.current, text)
      appliedRef.current = next
      controller.textInput.setInput(next)
    },
    [controller, live],
  )

  const handleFinal = useCallback(
    (text: string) => {
      setPartial("")
      const current = controller.textInput.value
      // It only rewrites the field if it still has the provisional text we
      // showed — with the user typing over it, their text rules.
      const anchored = live && current === appliedRef.current
      const base = anchored ? baseRef.current : current
      if (!text.trim()) {
        if (anchored) controller.textInput.setInput(base)
        return
      }
      const next = appendDictation(base, text)
      appliedRef.current = next
      controller.textInput.setInput(next)
    },
    [controller, live],
  )

  // Microphone levels for the wave: ref, not state — they arrive every ~64 ms and the
  // canvas reads them directly, without a re-render per block.
  const levelsRef = useRef<WaveLevels>({ values: [], at: 0 })
  const handleLevel = useCallback((level: number) => {
    levelsRef.current.values.push(level)
    levelsRef.current.at = performance.now()
  }, [])

  const dictation = useDictation({ onPartial: handlePartial, onFinal: handleFinal, onLevel: handleLevel })
  const { enabled, engine, modelId, threads, preload } = dictation.settings
  const { listening, starting, error, start, stop, cancel, dismissError } = dictation

  // The reason for the error appears next to the button and goes away by itself — before it stayed only
  // in the `title` (hover) and the microphone stayed red until the next attempt.
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(dismissError, 6000)
    return () => clearTimeout(timer)
  }, [error, dismissError])

  // State of the engine on disk (it downloads nothing here — the download is in the
  // preferences tab). Without a reliable answer the button stays enabled.
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refreshStatus = useCallback(() => {
    // Without the IPC bridge (preview in the browser) there is no channel to query — and the
    // button is not even drawn.
    if (!dictationSupported()) return
    void voiceApi
      .status()
      .then((raw) => {
        if (aliveRef.current) setStatus(parseVoiceStatus(raw))
      })
      .catch(() => {
        if (aliveRef.current) setStatus(null)
      })
  }, [])

  useEffect(() => {
    if (!settingsOpen) refreshStatus()
  }, [refreshStatus, engine, modelId, settingsOpen])

  const localReady = voiceTargetReady(status, engine, modelId)

  // With the microphone in view there is already a usable target: it warms the engine NOW,
  // in the background, so the first dictation does not wait for the loading of the
  // model (in Parakeet that is hundreds of MB in the ONNX Runtime, and that was what
  // left the red button stuck when holding for the first time). Idempotent —
  // calling it again does not redo the load.
  useEffect(() => {
    // Turned off, the user chose to pay the load on the first dictation — it does not
    // warm up in advance (the main process checks the same preference again).
    // Dictation turned off warms nothing: the button does not even appear, and loading the
    // model here held hundreds of MB for whoever turned off precisely the voice.
    if (!enabled || !localReady || !preload) return
    void voiceApi.sttWarm({ engine, modelId: modelId ?? undefined, threads })
  }, [enabled, localReady, preload, engine, modelId, threads])
  // Dictation target: the engine ready on disk (`localReady`), OR the chat AI model
  // accepting audio with the audio priority pointing at it. Without
  // either of the two the button does NOT disappear: it starts leading to the download
  // (`needsModel`), which is the path of whoever has no model at all yet.
  const viaModel = audioPriority === "model" && modelAcceptsAudio(model)
  const usable = localReady || viaModel
  const needsModel = !usable
  const active = listening || starting

  // Main path of whoever has not downloaded a model yet: the button is in view and the
  // click (or Space/Enter) leads to the download, instead of dictating.
  const openVoiceSettings = useCallback(() => openSettings("voice"), [openSettings])

  /**
   * Opens Preferences on the voice tab — it is what the button does with whoever has no
   * model yet. It runs on the CLICK (release), not on `pointerdown`, on purpose: the
   * modal mounts under the still pressed pointer, and the `click` the
   * browser fires on release falls OUTSIDE it. Base UI dismisses on `click`
   * (`useDismiss`), so the modal opened and closed in the same gesture.
   */
  const openVoiceSettingsOnClick = useCallback(() => {
    if (!needsModel) return
    openVoiceSettings()
  }, [needsModel, openVoiceSettings])

  const beginPress = useCallback(() => {
    // Dictation anchor: what was already in the field at this instant.
    baseRef.current = controller.textInput.value
    appliedRef.current = baseRef.current
    setPartial("")
    levelsRef.current = { values: [], at: performance.now() }
    void start()
  }, [controller, start])

  /** Press: ends hands-free mode, if it is in it; otherwise it starts listening. */
  const beginOrEndPress = useCallback(() => {
    if (latchedRef.current) {
      latchedRef.current = false
      setLatched(false)
      releaseHandledRef.current = true
      void stop()
      return
    }
    pressAtRef.current = Date.now()
    beginPress()
  }, [beginPress, stop])

  const press = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return
      // With no target, the press does nothing: what opens Preferences is the `click`
      // of the release (see `openVoiceSettingsOnClick`). Opening here mounted the modal
      // under the still pressed pointer and the following `click` dismissed it.
      if (needsModel) return
      event.preventDefault()
      if (pressedRef.current) return
      pressedRef.current = true
      // Captures the pointer: releasing outside the button still ends the dictation.
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // pointer already released — the pointerup arrives anyway
      }
      beginOrEndPress()
    },
    [beginOrEndPress, needsModel],
  )

  const endPress = useCallback(() => {
    if (!pressedRef.current) return
    pressedRef.current = false
    if (releaseHandledRef.current) {
      releaseHandledRef.current = false
      return
    }
    // Released soon: it was a tap, not a "hold" — the microphone stays open.
    if (Date.now() - pressAtRef.current < TAP_MS) {
      latchedRef.current = true
      setLatched(true)
      return
    }
    void stop()
  }, [stop])

  const keyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== " " && event.key !== "Enter") return
      // With no target, it lets the keyboard trigger the button the native way: the resulting
      // `click` opens Preferences, just like the mouse.
      if (needsModel) return
      // Space/Enter hold the speech: the default (trigger on keyup) would become a
      // dictation of zero duration.
      event.preventDefault()
      if (event.repeat || pressedRef.current) return
      pressedRef.current = true
      beginOrEndPress()
    },
    [beginOrEndPress, needsModel],
  )

  // The capture ended through another path (error, cancellation): it leaves hands-free.
  useEffect(() => {
    if (!listening && !starting && latchedRef.current) {
      latchedRef.current = false
      setLatched(false)
    }
  }, [listening, starting])

  // Hands-free: Esc discards the speech without transcribing.
  useEffect(() => {
    if (!latched) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      latchedRef.current = false
      setLatched(false)
      cancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [latched, cancel])

  // They turned dictation off in the preferences in the middle of the speech: it ends right away.
  useEffect(() => {
    if (!enabled && listening) cancel()
  }, [enabled, listening, cancel])

  // The button stays in view even WITHOUT a ready target: it is what leads to the download (the
  // click with `needsModel` opens Preferences on the voice tab). Requiring `usable`
  // here hid the microphone from whoever has not downloaded a model yet — which is
  // exactly who needs to see it to download.
  if (!enabled || !dictationSupported() || inCall) return null

  // With no live text in the field (preference off, or the audio going to the
  // model) the wave is the feedback that it is recording.
  const showWave = active && (!live || viaModel)


  const title = error
    ? `${t("voice.stt.error")} ${error}`
    : needsModel
      ? t("voice.stt.setupModel")
      : active
        ? latched
          ? t("voice.stt.listeningTap")
          : t("voice.stt.listening")
        : t("voice.stt.dictate")

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {showWave && <DictationWave levels={levelsRef} className="w-[calc(100cqw-3.25rem)]" />}
      {active && !live && !showWave && partial && (
        <Truncate text={partial}>
          <span aria-live="polite" className="max-w-40 truncate text-xs text-muted-foreground">
            {partial}
          </span>
        </Truncate>
      )}
      {error && !active && (
        
          <Truncate>
              <span role="status" title={error} className="max-w-56 truncate text-xs text-destructive">
              {t("voice.stt.error")} {error}
            </span>
          </Truncate>
      )}
      <Hint label={title}>
        <button
          type="button"
          aria-label={needsModel ? t("voice.stt.setupModel") : t("voice.stt.dictate")}
          aria-pressed={active}

          onPointerDown={press}
          onPointerUp={endPress}
          onPointerCancel={endPress}
          onLostPointerCapture={endPress}
          /* With no dictation target, what opens Preferences is the CLICK (release) and
             not the press — see `openVoiceSettingsOnClick`. */
          onClick={openVoiceSettingsOnClick}
          onKeyDown={keyDown}
          onKeyUp={(event) => {
            if (event.key === " " || event.key === "Enter") endPress()
          }}
          onContextMenu={(event) => event.preventDefault()}
          className={cn(
            "flex size-7 shrink-0 touch-none items-center justify-center rounded-md text-muted-foreground transition-colors select-none",
            "hover:bg-muted hover:text-foreground",
            // While recording, the hover does not "turn off" the red: it keeps saying that it is listening.
            active && "animate-pulse bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
            Boolean(error) && !active && "text-destructive hover:text-destructive",
            className,
          )}
        >
          <Mic className="size-4" />
        </button>
      </Hint>
    </div>
  )
}
