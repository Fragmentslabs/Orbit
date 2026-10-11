import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Mic } from "lucide-react"
import { usePromptInputController } from "@/src/components/ai/prompt-input"
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
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [partial, setPartial] = useState("")
  // Texto do input ao começar o ditado e o último valor que NÓS escrevemos:
  // juntos, permitem não sobrescrever o que o usuário digitar no meio da fala.
  const baseRef = useRef("")
  const appliedRef = useRef("")
  const pressedRef = useRef(false)
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

  const dictation = useDictation({ onPartial: handlePartial, onFinal: handleFinal })
  const { enabled, engine, modelId, threads, preload } = dictation.settings
  const { listening, starting, error, start, stop, cancel } = dictation

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
    if (!localReady || !preload) return
    void voiceApi.sttWarm({ engine, modelId: modelId ?? undefined, threads })
  }, [localReady, preload, engine, modelId, threads])
  // Regra do ícone: ele só aparece com um alvo utilizável — o motor de ditado
  // pronto no disco, OU o modelo de IA do chat aceitando áudio com a prioridade
  // de áudio apontando para o modelo. Sem nenhum dos dois não há ditado a
  // oferecer, e o botão simplesmente não existe.
  const viaModel = audioPriority === "model" && modelAcceptsAudio(model)
  const usable = localReady || viaModel
  const needsModel = !usable
  const active = listening || starting

  // Sem alvo utilizável o botão nem é montado (ver `usable` acima), então este
  // caminho só existe como rede: um status que chegue tarde não deixa o clique
  // num botão recém-inutilizável sem para onde ir.
  const openVoiceSettings = useCallback(() => openSettings("voice"), [openSettings])

  const beginPress = useCallback(() => {
    // Âncora do ditado: o que já estava no campo neste instante.
    baseRef.current = controller.textInput.value
    appliedRef.current = baseRef.current
    setPartial("")
    void start()
  }, [controller, start])

  const press = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return
      event.preventDefault()
      if (needsModel) {
        openVoiceSettings()
        return
      }
      if (pressedRef.current) return
      pressedRef.current = true
      // Captura o ponteiro: soltar fora do botão ainda encerra o ditado.
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // ponteiro já solto — o pointerup chega de qualquer forma
      }
      beginPress()
    },
    [beginPress, needsModel, openVoiceSettings],
  )

  const endPress = useCallback(() => {
    if (!pressedRef.current) return
    pressedRef.current = false
    void stop()
  }, [stop])

  const keyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== " " && event.key !== "Enter") return
      // Espaço/Enter seguram a fala: o padrão (acionar no keyup) viraria um
      // ditado de duração zero.
      event.preventDefault()
      if (needsModel) {
        openVoiceSettings()
        return
      }
      if (event.repeat || pressedRef.current) return
      pressedRef.current = true
      beginPress()
    },
    [beginPress, needsModel, openVoiceSettings],
  )

  // Desligaram o ditado nas preferências no meio da fala: encerra já.
  useEffect(() => {
    if (!enabled && listening) cancel()
  }, [enabled, listening, cancel])

  if (!enabled || !dictationSupported() || !usable) return null

  const title = error
    ? t("voice.stt.error")
    : needsModel
      ? t("voice.stt.setupModel")
      : active
        ? t("voice.stt.listening")
        : t("voice.stt.dictate")

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {active && !live && partial && (
        <span aria-live="polite" className="max-w-40 truncate text-xs text-muted-foreground">
          {partial}
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
        onKeyDown={keyDown}
        onKeyUp={(event) => {
          if (event.key === " " || event.key === "Enter") endPress()
        }}
        onContextMenu={(event) => event.preventDefault()}
        className={cn(
          "flex size-7 shrink-0 touch-none items-center justify-center rounded-md text-muted-foreground transition-colors select-none",
          "hover:bg-muted hover:text-foreground",
          active && "animate-pulse bg-destructive/10 text-destructive",
          Boolean(error) && !active && "text-destructive",
          className,
        )}
      >
        <Mic className="size-4" />
      </button>
    </div>
  )
}
