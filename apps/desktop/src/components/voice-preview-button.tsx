import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Play, Square } from "lucide-react"
import type { VoiceTtsEngine } from "@shared/voice"
import { useSpeak } from "@/src/hooks/use-speak"
import { cn } from "@/lib/utils"

/**
 * Frase de amostra por idioma da LEITURA (`voice.tts.lang`), não da interface:
 * é a língua em que a voz vai falar de verdade. No "Automático" a voz fala o
 * idioma do texto, então a amostra é a da interface (é nela que a pessoa
 * lê). "na" (agnóstico) e idiomas sem frase própria caem no inglês.
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
 * Ouvir a voz escolhida antes de usá-la: fala uma frase curta com a voz, o
 * idioma, a velocidade e a prioridade de áudio das preferências — o mesmo
 * caminho da leitura de uma resposta, então o que se ouve aqui é o que se vai
 * ouvir no chat. Clicar de novo enquanto fala para.
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

  // Trocou a voz no meio da amostra: a que está tocando já não é a escolhida.
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
        <span role="status" title={error} className="max-w-40 truncate text-[11px] text-destructive">
          {t("voice.tts.error")}
        </span>
      )}
      <button
        type="button"
        aria-label={label}
        title={label}
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
