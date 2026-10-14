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

/**
 * O modelo de IA aceita ÁUDIO na entrada? Só isso autoriza o ditado pelo modelo —
 * o formato do campo varia (lista de modalidades ou `{ input, output }`), então a
 * leitura aceita as duas formas.
 */
function modelAcceptsAudio(model: unknown): boolean {
  const modalities = (model as { modalities?: unknown } | undefined)?.modalities
  if (Array.isArray(modalities)) return modalities.includes("audio")
  const input = (modalities as { input?: unknown } | undefined)?.input
  return Array.isArray(input) && input.includes("audio")
}

/**
 * Botão de ditado do input: **segurar para falar, soltar para transcrever**.
 *
 * O texto cai no MESMO estado do input (o controlador do PromptInput) — é ele
 * que o textarea mostra e que o rascunho do chat persiste —, e sempre somado ao
 * que a pessoa já tinha digitado, nunca por cima. Com a preferência `live`
 * ligada o texto provisório do motor aparece no campo enquanto se fala; sem
 * `live` ele fica numa linha discreta ao lado do próprio botão.
 *
 * Sem o modelo/motor do ditado pronto o botão não fica morto: continua visível
 * e clicar (ou Espaço/Enter) abre as Preferências na aba de voz, onde o
 * download acontece.
 */
/** Abaixo disto a soltura conta como toque (liga o mãos livres), não "segurar". */
const TAP_MS = 300

export function DictationButton({ className, sessionId }: { className?: string; sessionId?: string }) {
  const { t } = useTranslation()
  const controller = usePromptInputController()
  // Modelo de IA do chat: com a prioridade de áudio em "model" ele é o outro
  // alvo possível do ditado (o áudio iria para ele em vez do motor do disco).
  const selected = useSessionModel(sessionId)
  const catalog = useProviderStore((s) => s.catalog)
  const model = selected ? catalog[selected.providerId]?.models[selected.modelId] : undefined
  // Mesma preferência que rege a fala (voice.tts.engine): uma prioridade de
  // áudio só, para as duas direções.
  const audioPriority = useAppSettings((s) =>
    readTtsEngine((s.settings as unknown as { voice?: unknown }).voice),
  )
  // `live` é lido aqui (e não do retorno do hook) porque os callbacks abaixo
  // precisam dele ANTES de o hook existir.
  const live = useAppSettings((s) => resolveVoiceSttSettings(s.settings).live)
  const openSettings = useSettingsUi((s) => s.openSettings)
  // A aba de voz é onde o modelo é baixado: fechá-la é o sinal para reavaliar
  // o estado do alvo (ainda não há evento reativo de status de voz).
  const settingsOpen = useSettingsUi((s) => s.open)
  // Em chamada, quem usa o microfone é ela: o botão de ditado sai de cena.
  const inCall = useVoiceActivity((s) => s.inCall)
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [partial, setPartial] = useState("")
  // Texto do input ao começar o ditado e o último valor que NÓS escrevemos:
  // juntos, permitem não sobrescrever o que o usuário digitar no meio da fala.
  const baseRef = useRef("")
  const appliedRef = useRef("")
  const pressedRef = useRef(false)
  // Toque rápido = mãos livres: o microfone fica aberto até o próximo clique.
  // Segurar continua sendo "segurar para falar". Sem isso, um clique abria e
  // fechava a captura no mesmo gesto (a persona piscava e nada era transcrito).
  const pressAtRef = useRef(0)
  const latchedRef = useRef(false)
  const [latched, setLatched] = useState(false)
  // O aperto que encerra o modo mãos livres: a soltura dele não faz mais nada.
  const releaseHandledRef = useRef(false)
  const aliveRef = useRef(true)

  const handlePartial = useCallback(
    (text: string) => {
      setPartial(text)
      if (!live) return
      const current = controller.textInput.value
      // O usuário digitou durante a fala: reancora no que ele escreveu.
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
      // Só reescreve o campo se ele ainda estiver com o provisório que
      // mostramos — com o usuário digitando por cima, o texto dele manda.
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

  // Níveis do microfone para a onda: ref, não estado — chegam a cada ~64 ms e o
  // canvas lê direto, sem re-render por bloco.
  const levelsRef = useRef<WaveLevels>({ values: [], at: 0 })
  const handleLevel = useCallback((level: number) => {
    levelsRef.current.values.push(level)
    levelsRef.current.at = performance.now()
  }, [])

  const dictation = useDictation({ onPartial: handlePartial, onFinal: handleFinal, onLevel: handleLevel })
  const { enabled, engine, modelId, threads, preload } = dictation.settings
  const { listening, starting, error, start, stop, cancel, dismissError } = dictation

  // O motivo do erro aparece ao lado do botão e some sozinho — antes ficava só
  // no `title` (hover) e o microfone seguia vermelho até a próxima tentativa.
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(dismissError, 6000)
    return () => clearTimeout(timer)
  }, [error, dismissError])

  // Estado do motor no disco (não baixa nada aqui — o download é na aba de
  // preferências). Sem resposta confiável o botão fica habilitado.
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refreshStatus = useCallback(() => {
    // Sem a ponte IPC (preview no navegador) não há canal para consultar — e o
    // botão nem chega a ser desenhado.
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

  // Com o microfone à vista já existe um alvo utilizável: aquece o motor AGORA,
  // em segundo plano, para o primeiro ditado não esperar o carregamento do
  // modelo (no Parakeet são centenas de MB no ONNX Runtime, e era isso que
  // deixava o botão vermelho parado ao prender pela primeira vez). Idempotente —
  // chamar de novo não refaz a carga.
  useEffect(() => {
    // Desligado, o usuário escolheu pagar a carga no primeiro ditado — não
    // aquece por antecipação (o main confere a mesma preferência de novo).
    // Ditado desligado não aquece nada: o botão nem aparece, e carregar o
    // modelo aqui prendia centenas de MB para quem desligou justamente a voz.
    if (!enabled || !localReady || !preload) return
    void voiceApi.sttWarm({ engine, modelId: modelId ?? undefined, threads })
  }, [enabled, localReady, preload, engine, modelId, threads])
  // Alvo do ditado: o motor pronto no disco (`localReady`), OU o modelo de IA do
  // chat aceitando áudio com a prioridade de áudio apontando para ele. Sem
  // nenhum dos dois o botão NÃO desaparece: ele passa a levar ao download
  // (`needsModel`), que é o caminho de quem ainda não tem modelo nenhum.
  const viaModel = audioPriority === "model" && modelAcceptsAudio(model)
  const usable = localReady || viaModel
  const needsModel = !usable
  const active = listening || starting

  // Caminho principal de quem ainda não baixou modelo: o botão está à vista e o
  // clique (ou Espaço/Enter) leva ao download, em vez de ditar.
  const openVoiceSettings = useCallback(() => openSettings("voice"), [openSettings])

  /**
   * Abre as Preferências na aba de voz — é o que o botão faz com quem ainda não
   * tem modelo. Roda no CLIQUE (soltura), não no `pointerdown`, de propósito: o
   * modal monta embaixo do ponteiro ainda pressionado, e o `click` que o
   * navegador dispara ao soltar cai FORA dele. O Base UI dispensa no `click`
   * (`useDismiss`), então o modal abria e fechava no mesmo gesto.
   */
  const openVoiceSettingsOnClick = useCallback(() => {
    if (!needsModel) return
    openVoiceSettings()
  }, [needsModel, openVoiceSettings])

  const beginPress = useCallback(() => {
    // Âncora do ditado: o que já estava no campo neste instante.
    baseRef.current = controller.textInput.value
    appliedRef.current = baseRef.current
    setPartial("")
    levelsRef.current = { values: [], at: performance.now() }
    void start()
  }, [controller, start])

  /** Aperto: encerra o modo mãos livres, se estiver nele; senão começa a ouvir. */
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
      // Sem alvo, o aperto não faz nada: quem abre as Preferências é o `click`
      // da soltura (ver `openVoiceSettingsOnClick`). Abrir aqui montava o modal
      // sob o ponteiro ainda pressionado e o `click` seguinte o dispensava.
      if (needsModel) return
      event.preventDefault()
      if (pressedRef.current) return
      pressedRef.current = true
      // Captura o ponteiro: soltar fora do botão ainda encerra o ditado.
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // ponteiro já solto — o pointerup chega de qualquer forma
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
    // Soltou logo: foi um toque, não um "segurar" — o microfone fica aberto.
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
      // Sem alvo, deixa o teclado acionar o botão do jeito nativo: o `click`
      // resultante abre as Preferências, igual ao mouse.
      if (needsModel) return
      // Espaço/Enter seguram a fala: o padrão (acionar no keyup) viraria um
      // ditado de duração zero.
      event.preventDefault()
      if (event.repeat || pressedRef.current) return
      pressedRef.current = true
      beginOrEndPress()
    },
    [beginOrEndPress, needsModel],
  )

  // A captura acabou por outro caminho (erro, cancelamento): sai do mãos livres.
  useEffect(() => {
    if (!listening && !starting && latchedRef.current) {
      latchedRef.current = false
      setLatched(false)
    }
  }, [listening, starting])

  // Mãos livres: Esc descarta a fala sem transcrever.
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

  // Desligaram o ditado nas preferências no meio da fala: encerra já.
  useEffect(() => {
    if (!enabled && listening) cancel()
  }, [enabled, listening, cancel])

  // O botão fica à vista mesmo SEM alvo pronto: é ele que leva ao download (o
  // clique com `needsModel` abre as Preferências na aba de voz). Exigir `usable`
  // aqui escondia o microfone de quem ainda não baixou modelo — que é
  // exatamente quem precisa vê-lo para baixar.
  if (!enabled || !dictationSupported() || inCall) return null

  // Sem texto ao vivo no campo (preferência desligada, ou o áudio indo para o
  // modelo) a onda é o retorno de que está gravando.
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
        <span aria-live="polite" className="max-w-40 truncate text-xs text-muted-foreground">
          {partial}
        </span>
      )}
      {error && !active && (
        <span role="status" title={error} className="max-w-56 truncate text-xs text-destructive">
          {t("voice.stt.error")} {error}
        </span>
      )}
      <button
        type="button"
        aria-label={needsModel ? t("voice.stt.setupModel") : t("voice.stt.dictate")}
        aria-pressed={active}
        title={title}
        onPointerDown={press}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onLostPointerCapture={endPress}
        /* Sem alvo de ditado, quem abre as Preferências é o CLIQUE (soltura) e
           não o aperto — ver `openVoiceSettingsOnClick`. */
        onClick={openVoiceSettingsOnClick}
        onKeyDown={keyDown}
        onKeyUp={(event) => {
          if (event.key === " " || event.key === "Enter") endPress()
        }}
        onContextMenu={(event) => event.preventDefault()}
        className={cn(
          "flex size-7 shrink-0 touch-none items-center justify-center rounded-md text-muted-foreground transition-colors select-none",
          "hover:bg-muted hover:text-foreground",
          // Gravando, o hover não "desliga" o vermelho: continua dizendo que está ouvindo.
          active && "animate-pulse bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
          Boolean(error) && !active && "text-destructive hover:text-destructive",
          className,
        )}
      >
        <Mic className="size-4" />
      </button>
    </div>
  )
}
