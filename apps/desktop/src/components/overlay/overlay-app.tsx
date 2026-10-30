import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { AudioLines, Check, Copy, Keyboard, ShieldAlert, X } from "lucide-react"
import { OVERLAY_DEFAULTS, type OverlayContext, type OverlaySettings } from "@shared/overlay"
import { MessageResponse } from "@/src/components/ai/message"
import { OrbitUiHostContext } from "@/src/components/ai/generative-ui"
import { Persona, type PersonaState } from "@/src/components/ai/persona"
import { AskCard } from "@/src/components/ask-card"
import { CompactInput } from "@/src/components/compact-input"
import { AskCardBatch } from "@/src/components/ask-card-batch"
import { DictationWave } from "@/src/components/dictation-wave"
import { useVoiceCallControl } from "@/src/components/voice-call"
import { assistantView } from "@/src/lib/overlay-answer"
import { chatApi, overlayApi } from "@/src/lib/ipc"
import { sessionReasoningFor } from "@/src/stores/session-reasoning"
import { readVisionModel, useProviderStore } from "@/src/stores/provider-store"
import { useSessionStore, type PendingAskUI } from "@/src/stores/session-store"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * The overlay panel (⇧⌘space), at the bottom of the screen.
 *
 * It is a "viewfinder" over a real session: the same engine, the same
 * history, the same model — only in a narrow strip, with the persona in
 * place of the icon and short answers. The session is fixed (the last one of the overlay)
 * so that "and now translate this" has something to point at; it appears in the sidebar
 * like any other conversation.
 *
 * Two modes, the same owner of the state (the existing call mode):
 *  - text: focused field, typed question, streaming answer;
 *  - call: live dictation and spoken answer — the answer arrives written and
 *    spoken at the same time, as in the input panel of the main window.
 */

const SESSION_KEY = "orbit-overlay-session"
const NO_ASKS: PendingAskUI[] = []

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
  /** Instant of the question: the previous answer leaves the screen as soon as one asks. */
  const [askedAt, setAskedAt] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const initRef = useRef<Promise<void> | null>(null)
  const autoStarted = useRef<number | null>(null)

  /**
   * Card height for the window to follow. The window is transparent and the card
   * has rounded corners: if it becomes SMALLER than it, the top is cut and the
   * top corners become a straight line. That is why the measurement is reported also on
   * every OPENING — the ResizeObserver only speaks when the size changes, and reopening
   * the panel in the same state left the window at the floor.
   */
  const reportHeight = useCallback(() => {
    const node = panelRef.current
    if (!node) return
    // +16 is the gap of the wrapper (p-2): 8 on top and 8 at the bottom. The window needs
    // all of it, otherwise the card touches the edges and loses the rounding.
    void overlayApi.resize(Math.ceil(node.getBoundingClientRect().height) + 16)
  }, [])

  const overlayModel = useAppSettingsModel()
  const selectedModel = useProviderStore((s) => s.selectedModel)
  const model = overlayModel ?? selectedModel

  // Fixed overlay session: created on the first opening, not at boot (otherwise
  // every app opening would leave an orphan "Shortcut" conversation in the sidebar).
  const ensureSession = useCallback(async (): Promise<string | null> => {
    // The store comes up on the FIRST opening, not in the pre-warm: the window is
    // created at boot and loading all the sessions there would be work paid by
    // whoever may never use the shortcut.
    initRef.current ??= Promise.all([
      useSessionStore.getState().initialize(),
      // Catalog along: without it the panel does not know whether the model always thinks
      // (`reasoningAlwaysOn`) nor the name of the models it shows.
      useProviderStore.getState().initialize(),
    ]).then(() => undefined)
    await initRef.current
    const state = useSessionStore.getState()
    const stored = localStorage.getItem(SESSION_KEY)
    const existing = stored ? state.sessions.find((session) => session.id === stored) : undefined
    if (existing) {
      // Conversation history: without this the reopening of the panel would show only the
      // new turn, and the "and now translate this" would lose the thread.
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
    // Tells the main process that the page already listens to `overlay:open` (see markOverlayReady).
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
      // Vision and thinking read from storage NOW: they may have changed in
      // Preferences after this window was born (the panel is pre-warmed at
      // boot and lives the whole session).
      const vision = look.vision ? readVisionModel() : null
      // Level of the overlay chat: its choice, otherwise the model's. Read from
      // storage now — this window is pre-warmed at boot.
      const reasoningPref = sessionReasoningFor(sessionId, model.providerId, model.modelId)
      const catalogModel = useProviderStore.getState().catalog[model.providerId]?.models[model.modelId]
      void chatApi.send({
        sessionId,
        text: body,
        providerId: model.providerId,
        modelId: model.modelId,
        mode: "chat",
        // `overlay` turns on the screen/selection tools and the short answer prompt;
        // `voiceCall` only in spoken mode (the answer is going to be read aloud);
        // `computer` lets Computer Use count when it is active in
        // Preferences — without this key the gate in app-settings.ts does not even create the
        // cu_* tools.
        options: {
          overlay: true,
          computer: true,
          voiceCall: spoken || undefined,
          // Thinking level of the overlay chat (or the model's, in
          // Preferences) — the same per-chat map the chat input uses.
          reasoning: {
            enabled: (reasoningPref?.enabled ?? false) || !!catalogModel?.reasoningAlwaysOn,
            variantId: reasoningPref?.variantId,
          },
        },
        // Vision mode on (default): the screen goes to the vision model, which
        // returns text — it works with any main model. Turned off, the
        // image only goes to the model if it can see; without either of the two the
        // `see_screen` refuses and the agent says it cannot look.
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
  // Approval/question requests of THIS conversation: without this, the shortcut agent
  // asked permission to act in an app and the request only existed in a notification —
  // the task stayed stopped and, in call mode, the voice in silence.
  const asks = useSessionStore((s) => (sessionId ? s.pendingAsks[sessionId] ?? NO_ASKS : NO_ASKS))
  // Permission is the most common and the simplest: it stays at the top, in one line. The rest
  // (questions, sub-chats, batches) goes on in the full card.
  const permissionAsks = useMemo(() => asks.filter((ask) => ask.kind === "permission" && !ask.batchId), [asks])
  const otherAsks = useMemo(() => asks.filter((ask) => !(ask.kind === "permission" && !ask.batchId)), [asks])
  const view = useMemo(() => assistantView(messages, askedAt, busy), [messages, askedAt, busy])
  const answer = view.final
  /** Session for the inline Markdown components (orbit-ui) to talk to it. */
  const uiHost = useMemo(() => ({ sessionId: sessionId ?? undefined }), [sessionId])

  // The main process sends the context on opening (selection already read, mode and preferences).
  useEffect(() => {
    const offOpen = overlayApi.onOpen((next) => {
      setContext(next)
      setLook(next.settings)
      setText("")
      setNotice(null)
      setCopied(false)
      // Opening clean: the answer from the previous use does not reappear on screen. The thread of the
      // conversation goes on in the history (the "and now translate this" still points
      // to what was said before), but the panel is born empty.
      setAskedAt(Date.now())
      autoStarted.current = null
      // Reports the height on the next frame: the main process re-anchors the window without knowing
      // the card size, and without this a reopening in the same state kept the
      // window at the floor — cutting the top and the top corners.
      requestAnimationFrame(reportHeight)
      void ensureSessionRef
        .current()
        .catch(() => null)
        .then(setSessionId)
    })
    const offEvent = overlayApi.onEvent((event) => {
      if (event.type === "hangup") controlRef.current.call.hangUp()
      else if (event.type === "settings") setLook(event.settings)
      else if (event.type === "selection") {
        // Read a few instants after opening (the window does not wait for the
        // `osascript`): it enters the context without erasing what is already there.
        setContext((current) =>
          current ? { ...current, selection: event.text, selectionApp: event.app } : current,
        )
      }
    })
    return () => {
      offOpen()
      offEvent()
    }
  }, [reportHeight])

  // Opened in call mode: it starts listening as soon as the session exists. Once
  // per opening — turning the call off cannot turn it back on right after.
  useEffect(() => {
    if (!context?.call || !sessionId || autoStarted.current === context.at) return
    if (!control.ready) {
      setNotice(t("overlay.callUnavailable"))
      return
    }
    autoStarted.current = context.at
    control.start()
  }, [context, sessionId, control, t])

  // Text mode: the field is born with the focus (it is what the person came to do).
  useEffect(() => {
    if (!context || context.call) return
    const handle = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(handle)
  }, [context])

  // Esc closes it in any mode; the panel is not a work window.
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

  // The window follows the content (the bottom edge stays anchored in the main process).
  useEffect(() => {
    const node = panelRef.current
    if (!node) return
    const observer = new ResizeObserver(() => reportHeight())
    observer.observe(node)
    return () => observer.disconnect()
  }, [reportHeight])

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
   * The body is born CLOSED: the shortcut opens only the field. It opens when there is something
   * to show — the answer arriving, a warning or an error. The selection alone opens
   * nothing (it appears as the field placeholder and as context of the turn).
   */
  const showBody = Boolean(answer || view.progress || errorText || notice || busy)

  return (
    <div className="flex h-full w-full items-end justify-center p-2">
      <div
        ref={panelRef}
        className="w-full overflow-hidden rounded-[18px] border border-border/70 shadow-[0_4px_12px_-6px_rgba(0,0,0,0.8)]"
        style={{ backgroundColor: `color-mix(in oklab, var(--card) ${opacity}%, transparent)` }}
      >
        {permissionAsks.map((ask) => (
          <OverlayPermission key={ask.requestId} ask={ask} />
        ))}
        {/* Header: persona + question OR live listening */}
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
                <Truncate text={live
                    ? call.partial || t("overlay.listening")
                    : heard || t(call.phase === "thinking" ? "overlay.thinking" : "overlay.speaking")}>
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
                </Truncate>
              </div>
            ) : (
              <CompactInput
                ref={inputRef}
                value={text}
                onChange={setText}
                onSubmit={(value) => submit(value, false)}
                placeholder={selection ? t("overlay.placeholderSelection") : t("overlay.placeholder")}
              />
            )}
          </div>

          {call.active ? (
            // Going back to typing without closing the panel: it turns off the listening and gives the
            // focus to the field. Without this, whoever opens it speaking would stay stuck in call
            // mode until closing and reopening (and the shortcut reopens speaking).
            <Hint label={t("overlay.type")}>
              <button
                type="button"
                onClick={() => {
                  call.hangUp()
                  requestAnimationFrame(() => inputRef.current?.focus())
                }}

                aria-label={t("overlay.type")}
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Keyboard className="size-4" />
              </button>
            </Hint>
          ) : (
            <Hint label={t("overlay.speak")}>
              <button
                type="button"
                onClick={startCall}

                aria-label={t("overlay.speak")}
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <AudioLines className="size-4" />
              </button>
            </Hint>
          )}
          <Hint label={t("overlay.close")}>
            <button
              type="button"
              onClick={() => void overlayApi.close()}

              aria-label={t("overlay.close")}
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </Hint>
        </div>

        {otherAsks.length > 0 && sessionId && (
          <div className="flex flex-col gap-2 border-t border-border/70 px-3 py-2.5">
            {otherAsks
              .filter((ask) => !ask.batchId)
              .map((ask) => (
                <AskCard key={ask.requestId} ask={ask} sessionId={sessionId} />
              ))}
            {[...new Set(otherAsks.map((ask) => ask.batchId).filter(Boolean))].map((batchId) => (
              <AskCardBatch key={batchId} items={otherAsks.filter((ask) => ask.batchId === batchId)} />
            ))}
          </div>
        )}

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
              {/* Where the text came from: without a label, "translate this" has no subject. */}
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
                  <div
                    className={cn(
                      // Real Markdown: the panel showed the RAW text, with
                      // `**` and `#` in view. It is the same renderer as the answer
                      // in the conversation — so list, table and code come out the same.
                      "select-text overflow-y-auto text-[13px] leading-[1.55] text-foreground",
                      // Spoken, the answer is short; if it goes past that, it scrolls.
                      call.active ? "max-h-[132px]" : "max-h-[320px]",
                    )}
                  >
                    {/* The host carries the session of this conversation: an orbit-ui block
                        (buttons, table) keeps working here. */}
                    <OrbitUiHostContext.Provider value={uiHost}>
                      <MessageResponse>{answer}</MessageResponse>
                    </OrbitUiHostContext.Provider>
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

              {!answer && busy && (
                // Working: what it narrates along the way, in gray — it is not the answer.
                <p className="line-clamp-3 select-text whitespace-pre-wrap text-[12px] leading-[1.5] text-muted-foreground">
                  {view.progress || t("overlay.thinking")}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Model chosen in Preferences → Overlay (null = the conversation model). */
function useAppSettingsModel() {
  const [model, setModel] = useState<OverlaySettings["model"]>(null)
  useEffect(() => {
    void overlayApi.settings().then((settings) => {
      setModel(settings.model)
      // The opacity/persona the main process already sends in the context on opening; here only the
      // model, which changes with the panel closed.
    })
    const off = overlayApi.onEvent((event) => {
      if (event.type === "settings") setModel(event.settings.model)
    })
    return off
  }, [])
  return model
}

/**
 * Permission request in the shortcut panel: one line at the top, with the title of the
 * request and Allow (the X denies). The panel is narrow and whoever is talking to
 * it wants to move on — the full detail (always in this chat, always) stays in the
 * conversation card in the main window.
 */
function OverlayPermission({ ask }: { ask: PendingAskUI }) {
  const { t } = useTranslation()
  const [sent, setSent] = useState(false)
  const reply = (value: "allow" | "deny") => {
    setSent(true)
    void chatApi.askReply(ask.requestId, value)
  }
  const critical = ask.claim?.critical === true
  return (
    <div className="flex items-center gap-2 border-b border-border/70 py-1.5 pl-3 pr-1.5">
      <ShieldAlert className={cn("size-3.5 shrink-0", critical ? "text-destructive" : "text-primary")} aria-hidden />
      <Truncate text={ask.claim?.title ?? t("overlay.permissionFallback")}>
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground" >
          {ask.claim?.title ?? t("overlay.permissionFallback")}
        </span>
      </Truncate>
      <Hint label={t("permissions.deny")}>
        <button
          type="button"
          disabled={sent}
          onClick={() => reply("deny")}
          aria-label={t("permissions.deny")}

          className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <X className="size-3.5" />
        </button>
      </Hint>
      <button
        type="button"
        disabled={sent}
        onClick={() => reply("allow")}
        className="h-6 shrink-0 rounded-full bg-primary px-2.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-50"
      >
        {t("overlay.allow")}
      </button>
    </div>
  )
}
