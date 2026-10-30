import { useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { SquareIcon, Volume2Icon } from "lucide-react"
import { Action } from "@/src/components/ai/actions"
import { readTtsEngine, readTtsPrefs, useSpeak, useTtsStatus } from "@/src/hooks/use-speak"
import { useAppSettings } from "@/src/stores/app-settings"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { Truncate } from "@/components/ui/truncated-text"

/** How long the error notice stays in view before the button goes back to normal. */
const ERROR_VISIBLE_MS = 6000

/**
 * SPEAK: reads the text aloud through the main process engine, in streaming. It sits next to
 * copy and becomes "stop" while speaking — clicking again interrupts. It is only
 * mounted in the assistant replies, with the text of the final answer
 * (`speakableText`); with nothing to read, it does not appear.
 *
 * Turned off in the preferences (`voice.tts.enabled`), the button does not even appear. Without the
 * model downloaded it STAYS visible, but instead of being dead it leads to
 * Preferences on the voice tab — where the download happens.
 */
export function SpeakAction({ text }: { text: string }) {
  const { t } = useTranslation()
  // The shared type may not carry the `voice` block yet (another worker):
  // it reads defensively from the store, with the app defaults.
  const voice = useAppSettings((s) => (s.settings as unknown as { voice?: unknown }).voice)
  const prefs = useMemo(() => readTtsPrefs(voice), [voice])
  // Audio priority: the button reflects the engine that IS GOING TO speak — the model route
  // when it exists; the local engine when not.
  const engine = useMemo(() => readTtsEngine(voice), [voice])
  const { ready, known } = useTtsStatus(prefs.enabled, engine)
  const openSettings = useSettingsUi((s) => s.openSettings)
  const { speak, stop, speaking, generating, error, dismissError } = useSpeak()

  // The error was only the button color + a tooltip that appeared on hover, and did not
  // go away anymore: the button stayed red until the next attempt. Now the reason
  // appears next to it and goes away by itself, returning the button to normal.
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(dismissError, ERROR_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [error, dismissError])

  if (!prefs.enabled) return null
  // Reply without text (tools only, for example): there is nothing to read.
  if (!text.trim()) return null

  if (known && !ready) {
    const setup = t("voice.tts.setupModel")
    return (
      <Action tooltip={setup} label={setup} onClick={() => openSettings("voice")}>
        <Volume2Icon className="size-3.5" />
      </Action>
    )
  }

  const label = generating
    ? t("voice.tts.generating")
    : speaking
      ? t("voice.tts.stop")
      : error
        ? t("voice.tts.error")
        : t("voice.tts.speak")

  return (
    <>
      <Action
        tooltip={label}
        label={label}
        className={
          // While speaking, the hover does not "turn off" the red: clicking is still stopping.
          generating
            ? "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive"
            : speaking
              ? "animate-pulse bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive"
              : error
                ? "text-destructive hover:text-destructive"
                : undefined
        }
        onClick={() => {
          if (speaking) stop()
          else speak(text, { voice: prefs.voice, lang: prefs.lang, speed: prefs.speed, engine })
        }}
      >
        {generating ? (
          <span aria-hidden className="voice-gen-bars">
            <span />
            <span />
            <span />
          </span>
        ) : speaking ? (
          <SquareIcon className="size-3.5" />
        ) : (
          <Volume2Icon className="size-3.5" />
        )}
      </Action>
      {error && !speaking && (
        
          <Truncate>
              <span role="status" title={error} className="max-w-72 truncate text-xs text-destructive">
              {t("voice.tts.error")} {error}
            </span>
          </Truncate>
      )}
    </>
  )
}
