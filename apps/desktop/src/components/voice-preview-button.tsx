import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Play, Square } from "lucide-react"
import type { VoiceTtsEngine } from "@shared/voice"
import { useSpeak } from "@/src/hooks/use-speak"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Sample sentence per READING language (`voice.tts.lang`), not of the interface:
 * it is the language in which the voice is really going to speak. In "Automatic" the voice speaks the
 * language of the text, so the sample is the interface one (it is in it that the person
 * reads). "na" (agnostic) and languages without their own sentence fall into English.
 */
const SAMPLES: Record<string, string> = {
  pt: "Olá! Esta é a minha voz. É assim que vou ler as suas respostas.",
  en: "Hi! This is my voice. This is how I will read your answers.",
  es: "¡Hola! Esta es mi voz. Así es como voy a leer tus respuestas.",
  fr: "Bonjour ! Voici ma voix. C'est ainsi que je lirai vos réponses.",
  de: "Hallo! Das ist meine Stimme. So werde ich deine Antworten vorlesen.",
  it: "Ciao! Questa è la mia voce. È così che leggerò le tue risposte.",
}

export function voiceSample(lang: string): string {
  return SAMPLES[lang] ?? SAMPLES.en
}

/**
 * Listen to the chosen voice before using it: it speaks a short sentence with the voice, the
 * language, the speed and the audio priority of the preferences — the same
 * path as the reading of an answer, so what one hears here is what one is going to
 * hear in the chat. Clicking again while it speaks stops it.
 */
export function VoicePreviewButton({
  voice,
  lang,
  speed,
  engine,
}: {
  voice: string
  lang: string
  speed: number
  engine: VoiceTtsEngine
}) {
  const { t, i18n } = useTranslation()
  const { speak, stop, speaking, generating, error, dismissError } = useSpeak()
  const sampleLang = lang === "auto" ? (i18n.language || "en").slice(0, 2).toLowerCase() : lang

  // The voice was swapped in the middle of the sample: the one playing is no longer the chosen one.
  useEffect(() => {
    stop()
  }, [voice, lang, speed, engine, stop])

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(dismissError, 6000)
    return () => clearTimeout(timer)
  }, [error, dismissError])

  const label = speaking ? t("voice.settings.tts.previewStop") : t("voice.settings.tts.preview")
  return (
    <div className="flex items-center gap-1.5">
      {error && !speaking && (
        <Truncate text={t("voice.tts.error")}>
          <span role="status"  className="max-w-40 truncate text-[11px] text-destructive">
            {t("voice.tts.error")}
          </span>
        </Truncate>
      )}
      <button
        type="button"
        aria-label={label}
        onClick={() => (speaking ? stop() : speak(voiceSample(sampleLang), { voice, lang, speed, engine }))}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md border border-input transition-colors",
          speaking
            ? "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        {generating ? (
          <span aria-hidden className="voice-gen-bars">
            <span />
            <span />
            <span />
          </span>
        ) : speaking ? (
          <Square className="size-3.5" />
        ) : (
          <Play className="size-3.5" />
        )}
      </button>
    </div>
  )
}
