import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { AudioLines, Check, Copy, Keyboard, X } from "lucide-react"
import type { ChatMessage } from "@shared/chat"
import { OVERLAY_DEFAULTS, type OverlayContext, type OverlaySettings } from "@shared/overlay"
import { Persona, type PersonaState } from "@/src/components/ai/persona"
import { DictationWave } from "@/src/components/dictation-wave"
import { useVoiceCallControl } from "@/src/components/voice-call"
import { chatApi, overlayApi } from "@/src/lib/ipc"
import { readReasoningPref } from "@/src/stores/reasoning-prefs"
import { readVisionModel, useProviderStore } from "@/src/stores/provider-store"
import { useSessionStore } from "@/src/stores/session-store"
import { cn } from "@/lib/utils"

/**
 * O painel do overlay (⇧⌘espaço), no rodapé da tela.
 *
 * Ele é um "visor" sobre uma sessão de verdade: a mesma engine, o mesmo
 * histórico, o mesmo modelo — só que numa faixa estreita, com a persona no
 * lugar do ícone e respostas curtas. A sessão é fixa (a última do overlay)
 * para o "e agora traduz isso" ter para onde apontar; ela aparece no sidebar
 * como qualquer outra conversa.
 *
 * Dois modos, o mesmo dono do estado (o modo chamada existente):
 *  - texto: campo focado, pergunta digitada, resposta em streaming;
 *  - chamada: ditado ao vivo e resposta falada — a resposta chega escrita e
 *    falada ao mesmo tempo, como no painel do input da janela principal.
 */

const SESSION_KEY = "orbit-overlay-session"

/** Texto da última resposta do assistente (streaming incluído). */
function assistantText(messages: ChatMessage[] | undefined, since: number): string {
  if (!messages) return ""
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== "assistant" || message.summary) continue
    if (since > 0 && message.createdAt < since) return ""
    return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
  }
  return ""
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export function OverlayApp() {
  const { t } = useTranslation()
  const [context, setContext] = useState<OverlayContext | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [look, setLook] = useState<OverlaySettings>(OVERLAY_DEFAULTS)
  const [text, setText] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  /** Instante da pergunta: a resposta anterior sai da tela assim que se pergunta. */
  const [askedAt, setAskedAt] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const initRef = useRef<Promise<void> | null>(null)
  const autoStarted = useRef<number | null>(null)

  const overlayModel = useAppSettingsModel()
  const selectedModel = useProviderStore((s) => s.selectedModel)
  const model = overlayModel ?? selectedModel

  // Sessão fixa do overlay: criada na primeira abertura, não no boot (senão
  // toda abertura do app deixaria uma conversa "Atalho" órfã no sidebar).
  const ensureSession = useCallback(async (): Promise<string | null> => {
    // O store sobe na PRIMEIRA abertura, não no pré-aquecimento: a janela é
    // criada no boot e carregar todas as sessões ali seria trabalho pago por
    // quem talvez nunca use o atalho.
    initRef.current ??= Promise.all([
      useSessionStore.getState().initialize(),
      // Catálogo junto: sem ele o painel não sabe se o modelo pensa sempre
      // (`reasoningAlwaysOn`) nem o nome dos modelos que mostra.
      useProviderStore.getState().initialize(),
    ]).then(() => undefined)
    await initRef.current
    const state = useSessionStore.getState()
    const stored = localStorage.getItem(SESSION_KEY)
    const existing = stored ? state.sessions.find((session) => session.id === stored) : undefined
    if (existing) {
      // Histórico da conversa: sem isto a reabertura do painel mostraria só o
      // turno novo, e o "e agora traduz isso" perderia o fio.
      await state.ensureMessages(existing.id)
      return existing.id
    }
    const created = await state.createSession("chat", {
      title: t("overlay.sessionTitle"),
      setActive: false,
    })
    await state.ensureMessages(created.id)
    localStorage.setItem(SESSION_KEY, created.id)
    return created.id
  }, [t])
  const ensureSessionRef = useRef(ensureSession)
  ensureSessionRef.current = ensureSession

  useEffect(() => {
    // Avisa o main que a página já escuta `overlay:open` (ver markOverlayReady).
    overlayApi.ready()
  }, [])

  const submit = useCallback(
    (raw: string, spoken: boolean): boolean => {
      const body = raw.trim()
      if (!body) return false
      if (!sessionId) {
        setNotice(t("overlay.preparing"))
        return false
      }
      if (!model) {
        setNotice(t("overlay.noModel"))
        return false
      }
      setNotice(null)
      setCopied(false)
      setAskedAt(Date.now())
      // Visão e thinking lidos do storage AGORA: podem ter mudado nas
      // Preferências depois que esta janela nasceu (o painel é pré-aquecido no
      // boot e vive a sessão inteira).
      const vision = look.vision ? readVisionModel() : null
      const reasoningPref = readReasoningPref(model.providerId, model.modelId)
      const catalogModel = useProviderStore.getState().catalog[model.providerId]?.models[model.modelId]
      void chatApi.send({
        sessionId,
        text: body,
        providerId: model.providerId,
        modelId: model.modelId,
        mode: "chat",
        // `overlay` liga as tools de tela/seleção e o prompt de resposta curta;
        // `voiceCall` só no modo falado (a resposta vai ser lida em voz alta);
        // `computer` deixa o Computer Use valer quando ele está ativo nas
        // Preferências — sem esta chave o gate em app-settings.ts nem cria as
        // tools cu_*.
        options: {
          overlay: true,
          computer: true,
          voiceCall: spoken || undefined,
          // Nível de thinking escolhido para este modelo nas Preferências —
          // o mesmo mapa por modelo que o input do chat lê e grava.
          reasoning: {
            enabled: (reasoningPref?.enabled ?? false) || !!catalogModel?.reasoningAlwaysOn,
            variantId: reasoningPref?.variantId,
          },
        },
        // Modo Visão ligado (padrão): a tela vai para o modelo de visão, que
        // devolve texto — funciona com qualquer modelo principal. Desligado, a
        // imagem só vai ao modelo se ele enxergar; sem nenhum dos dois o
        // `see_screen` recusa e o agente diz que não consegue olhar.
        visionModel: vision ?? undefined,
      })
      return true
    },
    [sessionId, model, look.vision, t],
  )
  const submitRef = useRef(submit)
  submitRef.current = submit

  const control = useVoiceCallControl({
    sessionId: sessionId ?? undefined,
    submit: (said) => submitRef.current(said, true),
  })
  const controlRef = useRef(control)
  controlRef.current = control

  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] : undefined))
  const status = useSessionStore((s) => (sessionId ? s.status[sessionId] : undefined))
  const busy = status === "submitted" || status === "streaming" || status === "fallback" || status === "cancelling"
  const answer = useMemo(() => assistantText(messages, askedAt), [messages, askedAt])

  // O main manda o contexto ao abrir (seleção já lida, modo e preferências).
  useEffect(() => {
    const offOpen = overlayApi.onOpen((next) => {
      setContext(next)
      setLook(next.settings)
      setText("")
      setNotice(null)
      setCopied(false)
      // Abrir limpo: a resposta do uso anterior não reaparece na tela. O fio da
      // conversa continua no histórico (o "e agora traduz isso" ainda aponta
      // para o que foi dito antes), mas o painel nasce vazio.
      setAskedAt(Date.now())
      autoStarted.current = null
      void ensureSessionRef
        .current()
        .catch(() => null)
        .then(setSessionId)
    })
    const offEvent = overlayApi.onEvent((event) => {
      if (event.type === "hangup") controlRef.current.call.hangUp()
      else if (event.type === "settings") setLook(event.settings)
      else if (event.type === "selection") {
        // Lida alguns instantes depois de abrir (a janela não espera o
        // `osascript`): entra no contexto sem apagar o que já está lá.
        setContext((current) =>
          current ? { ...current, selection: event.text, selectionApp: event.app } : current,
        )
      }
    })
    return () => {
      offOpen()
      offEvent()
    }
  }, [])

  // Abriu em modo chamada: começa a ouvir assim que a sessão existe. Uma vez
  // por abertura — desligar a chamada não pode religá-la em seguida.
  useEffect(() => {
    if (!context?.call || !sessionId || autoStarted.current === context.at) return
    if (!control.ready) {
      setNotice(t("overlay.callUnavailable"))
      return
    }
    autoStarted.current = context.at
    control.start()
  }, [context, sessionId, control, t])

  // Modo texto: o campo já nasce com o foco (é o que a pessoa veio fazer).
  useEffect(() => {
    if (!context || context.call) return
    const handle = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(handle)
  }, [context])

  // Esc fecha de qualquer modo; o painel não é uma janela de trabalho.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        void overlayApi.close()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // A janela acompanha o conteúdo (a borda de baixo fica ancorada no main).
  useEffect(() => {
    const node = panelRef.current
    if (!node) return
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(node.getBoundingClientRect().height) + 16
      void overlayApi.resize(height)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const copy = useCallback(() => {
    if (!answer) return
    void overlayApi.copy(answer).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }, [answer])

  const startCall = useCallback(() => {
    if (!control.ready) {
      setNotice(t("overlay.callUnavailable"))
      return
    }
    setNotice(null)
    setText("")
    control.start()
  }, [control, t])

  const call = control.call
  const personaState: PersonaState = call.active
    ? call.phase === "listening"
      ? "listening"
      : call.phase === "thinking"
        ? "thinking"
        : "speaking"
    : busy
      ? "thinking"
      : "idle"

  const selection = context?.selection ?? null
  const live = call.active && call.phase === "listening"
  const heard = call.active && call.phase !== "listening" ? call.heard : ""
  const errorText = call.error === "reply" ? t("voice.call.replyError") : call.error
  const opacity = Math.round(Math.min(1, Math.max(0.5, look.opacity)) * 100)
  /**
   * O corpo nasce FECHADO: o atalho abre só o campo. Ele abre quando há o que
   * mostrar — a resposta chegando, um aviso ou um erro. A seleção sozinha não
   * abre nada (ela aparece como placeholder do campo e como contexto do turno).
   */
  const showBody = Boolean(answer || errorText || notice || busy)

  return (
    <div className="flex h-full w-full items-end justify-center p-2">
      <div
        ref={panelRef}
        className="w-full overflow-hidden rounded-[18px] border border-border/70 shadow-[0_4px_12px_-6px_rgba(0,0,0,0.8)]"
        style={{ backgroundColor: `color-mix(in oklab, var(--card) ${opacity}%, transparent)` }}
      >
        {/* Cabeçalho: persona + pergunta OU escuta ao vivo */}
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center">
            {look.persona ? (
              <Persona state={personaState} className="size-9" />
            ) : (
              <span aria-hidden className="size-4 rounded-full border-[1.5px] border-primary/80" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            {call.active ? (
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "flex shrink-0 items-center",
                    call.phase === "speaking" && !call.waiting ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {live ? (
                    <DictationWave levels={call.levels} className="w-14 bg-transparent px-0" />
                  ) : (
                    <span aria-hidden className="voice-gen-bars">
                      <span />
                      <span />
                      <span />
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[13px]",
                    live && call.partial ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {live
                    ? call.partial || t("overlay.listening")
                    : heard || t(call.phase === "thinking" ? "overlay.thinking" : "overlay.speaking")}
                </span>
              </div>
            ) : (
              <input
                ref={inputRef}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return
                  event.preventDefault()
                  if (submit(text, false)) setText("")
                }}
                placeholder={selection ? t("overlay.placeholderSelection") : t("overlay.placeholder")}
                spellCheck={false}
                className="w-full bg-transparent text-[13.5px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/70"
              />
            )}
          </div>

          {call.active ? (
            // Voltar a digitar sem fechar o painel: desliga a escuta e devolve o
            // foco ao campo. Sem isto, quem abre falando ficaria preso no modo
            // chamada até fechar e reabrir (e o atalho reabre falando).
            <button
              type="button"
              onClick={() => {
                call.hangUp()
                requestAnimationFrame(() => inputRef.current?.focus())
              }}
              title={t("overlay.type")}
              aria-label={t("overlay.type")}
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Keyboard className="size-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={startCall}
              title={t("overlay.speak")}
              aria-label={t("overlay.speak")}
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <AudioLines className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={() => void overlayApi.close()}
            title={t("overlay.close")}
            aria-label={t("overlay.close")}
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out",
            showBody ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div
              className={cn(
                "border-t border-border/70 px-3.5 py-2.5 transition-opacity duration-200",
                showBody ? "opacity-100" : "opacity-0",
              )}
            >
              {/* De onde veio o texto: sem rótulo, "traduz isso" não tem sujeito. */}
              {selection && !answer && (
                <p className="mb-1.5 line-clamp-1 text-[11px] text-muted-foreground">
                  <span className="text-muted-foreground/70">
                    {context?.selectionApp
                      ? t("overlay.selectedIn", { app: context.selectionApp })
                      : t("overlay.selected")}
                  </span>{" "}
                  “{truncate(selection, 90)}”
                </p>
              )}

              {errorText && <p className="text-[12px] text-destructive">{errorText}</p>}
              {notice && !answer && <p className="text-[12px] text-muted-foreground">{notice}</p>}

              {answer && (
                <>
                  <div className="max-h-[320px] select-text overflow-y-auto whitespace-pre-wrap text-[13.5px] leading-[1.55] text-foreground">
                    {answer}
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={copy}
                      className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                      {copied ? t("overlay.copied") : t("overlay.copy")}
                    </button>
                  </div>
                </>
              )}

              {!answer && busy && <p className="text-[12px] text-muted-foreground">{t("overlay.thinking")}</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Modelo escolhido em Preferências → Overlay (null = o modelo da conversa). */
function useAppSettingsModel() {
  const [model, setModel] = useState<OverlaySettings["model"]>(null)
  useEffect(() => {
    void overlayApi.settings().then((settings) => {
      setModel(settings.model)
      // A opacidade/persona o main já manda no contexto ao abrir; aqui só o
      // modelo, que muda com o painel fechado.
    })
    const off = overlayApi.onEvent((event) => {
      if (event.type === "settings") setModel(event.settings.model)
    })
    return off
  }, [])
  return model
}
