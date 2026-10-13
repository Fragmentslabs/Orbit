import { useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { SquareIcon, Volume2Icon } from "lucide-react"
import { Action } from "@/src/components/ai/actions"
import { readTtsEngine, readTtsPrefs, useSpeak, useTtsStatus } from "@/src/hooks/use-speak"
import { useAppSettings } from "@/src/stores/app-settings"
import { useSettingsUi } from "@/src/stores/settings-ui"

/** Quanto o aviso de erro fica à vista antes de o botão voltar ao normal. */
const ERROR_VISIBLE_MS = 6000

/**
 * FALAR: lê o texto em voz alta pelo motor do main, em streaming. Fica ao lado
 * do copiar e vira "parar" enquanto fala — clicar de novo interrompe. Só é
 * montado nas respostas do assistente, com o texto da resposta final
 * (`speakableText`); sem nada para ler, não aparece.
 *
 * Desligado nas preferências (`voice.tts.enabled`), o botão nem aparece. Sem o
 * modelo baixado ele CONTINUA visível, mas em vez de ficar morto leva às
 * Preferências na aba de voz — onde o download acontece.
 */
export function SpeakAction({ text }: { text: string }) {
  const { t } = useTranslation()
  // O tipo compartilhado pode ainda não trazer o bloco `voice` (outro worker):
  // lê defensivamente do store, com os padrões do app.
  const voice = useAppSettings((s) => (s.settings as unknown as { voice?: unknown }).voice)
  const prefs = useMemo(() => readTtsPrefs(voice), [voice])
  // Prioridade de áudio: o botão reflete o motor que VAI falar — a rota do
  // modelo quando ela existe; o motor local quando não.
  const engine = useMemo(() => readTtsEngine(voice), [voice])
  const { ready, known } = useTtsStatus(prefs.enabled, engine)
  const openSettings = useSettingsUi((s) => s.openSettings)
  const { speak, stop, speaking, generating, error, dismissError } = useSpeak()

  // O erro era só a cor do botão + um tooltip que aparecia no hover, e não
  // saía mais: o botão ficava vermelho até a próxima tentativa. Agora o motivo
  // aparece ao lado e some sozinho, devolvendo o botão ao normal.
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(dismissError, ERROR_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [error, dismissError])

  if (!prefs.enabled) return null
  // Resposta sem texto (só ferramentas, por exemplo): não há o que ler.
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
          // Falando, o hover não "desliga" o vermelho: clicar ainda é parar.
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
        <span role="status" title={error} className="max-w-72 truncate text-xs text-destructive">
          {t("voice.tts.error")} {error}
        </span>
      )}
    </>
  )
}
