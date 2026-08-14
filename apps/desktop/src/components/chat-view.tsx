import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronRight, PaperclipIcon } from "lucide-react"
import { UserMessageNav } from "@/src/components/user-message-nav"
import { useWorkspace } from "@/lib/workspace-context"
import type { ChatMessage, FilePart, OrchestrationPlan, PlanReview, SendMessageOptions } from "@shared/chat"
import { AskCard } from "@/src/components/ask-card"
import { AskCardBatch } from "@/src/components/ask-card-batch"
import { ChatInput } from "@/src/components/chat-input"
import { CodeInput } from "@/src/components/code-input"
import { VisionHintCard } from "@/src/components/vision-hint-card"
import { Persona, type PersonaState } from "@/src/components/ai/persona"
import { useAppearanceStore } from "@/src/stores/appearance-store"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/src/components/ai/conversation"
import { Message, MessageAttachment, MessageAttachments, MessageContent } from "@/src/components/ai/message"
import { Suggestion } from "@/src/components/ai/suggestion"
import { ChatAssistantMessage } from "@/src/components/messages/chat-message"
import { CodeAssistantMessage } from "@/src/components/messages/code-message"
import { SummaryCard } from "@/src/components/messages/summary-card"
import { OrchestrationPlanCard } from "@/src/components/orchestration-plan-card"
import { TaskProgress } from "@/src/components/task-progress"
import { PlanReviewCard } from "@/src/components/plan-review-card"
import { InitProjectCard } from "@/src/components/init-project-card"
import { RevertBar } from "@/src/components/revert-bar"
import { AssistantMessageActions, CopyAction, MessageTimestamp, RevertAction } from "@/src/components/messages/shared"
import { DateSeparator, isNewDay } from "@/src/components/messages/date-separator"
import { ChatMessageSearchBar } from "@/src/components/chat-message-search-bar"
import { useChatSearchStore } from "@/src/stores/chat-search-store"
import { Actions } from "@/src/components/ai/actions"
import { messageText, visibleMessageText } from "@/src/lib/message-utils"
import { useActiveSession, useSessionStatus, useSessionStore, type SendConfig } from "@/src/stores/session-store"
import { brainEnabledFor } from "@/src/stores/brain-prefs"
import { useProviderStore } from "@/src/stores/provider-store"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { useSimpleMode } from "@/src/stores/simple-prefs"

// Referências estáveis para seletores do zustand (evita loop de getSnapshot)
const NO_MESSAGES: ChatMessage[] = []
const NO_ASKS: never[] = []

// Memoizado por referência da mensagem + flags: no flush de deltas só a
// mensagem streamando muda de referência — as demais não re-renderizam.
// `messages`/`sendMessage` ficam fora da comparação de propósito: o retry usa
// `slice(0, index)`, imune a mensagens novas anexadas ao final da lista.
const MessageItem = memo(
  function MessageItem({ msg, isLast, waiting, finished, isBusy, mode, sessionId, sendMessage, messages, index }: {
    msg: ChatMessage
    isLast: boolean
    waiting: boolean
    finished: boolean
    isBusy: boolean
    mode: "chat" | "code"
    sessionId?: string
    sendMessage: (mode: "chat" | "code", text: string, config: SendConfig) => Promise<void>
    messages: ChatMessage[]
    index: number
  }) {
  const AssistantMessage = mode === "chat" ? ChatAssistantMessage : CodeAssistantMessage
  const { t } = useTranslation()

  const handleRetry = useCallback(() => {
    const prevUser = [...messages].slice(0, index).reverse().find((m) => m.role === "user")
    if (prevUser && sessionId) {
      void sendMessage(mode, messageText(prevUser), { options: {}, sessionId })
    }
  }, [messages, index, mode, sessionId, sendMessage])

  if (msg.role === "user") {
    const files = msg.parts.filter((p): p is FilePart => p.type === "file")
    return (
      <Message from="user" data-user-msg-id={msg.id} data-msg-id={msg.id}>
        <div className="group/user-msg flex flex-col">
          {files.length > 0 && (
            <MessageAttachments className="mb-1">
              {files.map((file) =>
                file.mime.startsWith("image/") ? (
                  <MessageAttachment
                    key={file.id}
                    data={{ type: "file", mediaType: file.mime, filename: file.filename, url: file.url }}
                  />
                ) : (
                  <div
                    key={file.id}
                    className="flex h-7 cursor-default select-none items-center gap-1.5 rounded-md border border-border px-1.5 text-sm"
                  >
                    <PaperclipIcon className="size-3 text-muted-foreground" />
                    <span className="truncate">{file.filename ?? t("attachments.unnamedFile")}</span>
                  </div>
                ),
              )}
            </MessageAttachments>
          )}
          <MessageContent>
            <p className="whitespace-pre-wrap">{visibleMessageText(msg)}</p>
          </MessageContent>
          <Actions className="-mb-1 items-center justify-end opacity-0 transition-opacity group-hover/user-msg:opacity-100">
            <MessageTimestamp timestamp={msg.createdAt} />
            <CopyAction text={visibleMessageText(msg)} />
            <RevertAction messageId={msg.id} sessionId={sessionId} />
          </Actions>
        </div>
      </Message>
    )
  }

  return (
    <Message from="assistant" data-msg-id={msg.id}>
      <MessageContent>
        <AssistantMessage
          message={msg}
          sessionId={sessionId}
          isLast={isLast}
          isBusy={isBusy}
          onRetry={handleRetry}
        />
      </MessageContent>
      {finished && !waiting && <AssistantMessageActions message={msg} />}
    </Message>
  )
  },
  (prev, next) =>
    prev.msg === next.msg &&
    prev.isLast === next.isLast &&
    prev.waiting === next.waiting &&
    prev.finished === next.finished &&
    prev.isBusy === next.isBusy &&
    prev.mode === next.mode &&
    prev.sessionId === next.sessionId &&
    prev.index === next.index,
)

function ChatMessages({ messages, isBusy, mode, sessionId, sendMessage, planIds, planReview, plan }: {
  messages: ChatMessage[]
  isBusy: boolean
  mode: "chat" | "code"
  sessionId?: string
  sendMessage: (mode: "chat" | "code", text: string, config: SendConfig) => Promise<void>
  planIds: Set<string>
  planReview: PlanReview | undefined
  plan?: OrchestrationPlan | undefined
}) {
  const { t } = useTranslation()
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant" && !m.summary)?.id

  const userMsgItems = useMemo(
    () =>
      messages
        .filter((m) => m.role === "user")
        .map((m) => ({ id: m.id, text: visibleMessageText(m), time: m.createdAt })),
    [messages],
  )

  const [activeUserMsgId, setActiveUserMsgId] = useState<string | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const ratioMapRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    const ids = userMsgItems.map((i) => i.id)
    const key = ids.join(",")
    if (!key) return

    const ratioMap = ratioMapRef.current
    ratioMap.clear()

    if (observerRef.current) observerRef.current.disconnect()

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-user-msg-id")
          if (id) ratioMap.set(id, entry.intersectionRatio)
        }
        let maxId: string | null = null
        let maxRatio = 0
        for (const [id, ratio] of ratioMap) {
          if (ratio > maxRatio) {
            maxRatio = ratio
            maxId = id
          }
        }
        setActiveUserMsgId(maxId)
      },
      { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] },
    )

    observerRef.current = observer

    const els = document.querySelectorAll<HTMLElement>("[data-user-msg-id]")
    for (const el of els) observer.observe(el)

    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMsgItems.map((i) => i.id).join(",")])

  const handleNavSelect = useCallback((id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-user-msg-id="${id}"]`)
    if (!el) return
    // Rola o container de scroll real (div interna do StickToBottom), que fica
    // sob um ancestral com overflow-y-hidden — scrollIntoView nem sempre rola
    // o container certo nessa estrutura.
    let scroller = el.parentElement
    while (scroller) {
      const overflowY = getComputedStyle(scroller).overflowY
      if (overflowY === "auto" || overflowY === "scroll") break
      scroller = scroller.parentElement
    }
    if (!scroller) return
    const containerRect = scroller.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const target =
      scroller.scrollTop +
      (elRect.top - containerRect.top) -
      (scroller.clientHeight - elRect.height) / 2
    const max = scroller.scrollHeight - scroller.clientHeight
    scroller.scrollTo({ top: Math.max(0, Math.min(target, max)), behavior: "smooth" })
  }, [])

  return (
    <Conversation key={sessionId ?? "no-session"} className="relative flex-1 -mt-10">
      <ConversationContent className="mx-auto w-full max-w-3xl">
        {messages.map((msg, index) => {
          const showSeparator = isNewDay(messages[index - 1]?.createdAt, msg.createdAt)

          if (msg.summary) {
            return (
              <div key={msg.id}>
                {showSeparator && <DateSeparator timestamp={msg.createdAt} />}
                <SummaryCard message={msg} />
              </div>
            )
          }

          const isLast = msg.id === lastAssistantId
          const finished = msg.role !== "assistant" || !(isLast && isBusy)
          const waiting = msg.role === "assistant" && isLast && isBusy && msg.parts.length === 0

          return (
            <div key={msg.id}>
              {showSeparator && <DateSeparator timestamp={msg.createdAt} />}
              <MessageItem
                msg={msg}
                isLast={isLast}
                waiting={waiting}
                finished={finished}
                isBusy={isBusy}
                mode={mode}
                sessionId={sessionId}
                sendMessage={sendMessage}
                messages={messages}
                index={index}
              />
            </div>
          )
        })}
        {planReview && planReview.status === "proposed" && sessionId && (
          <div className="px-1">
            <PlanReviewCard sessionId={sessionId} review={planReview} />
          </div>
        )}
        {planReview && planReview.status === "implementing" && sessionId && !plan && (
          <div className="px-1">
            <TaskProgress
              tasks={[{ id: "plan", title: t("chat.implementPlan"), status: isBusy ? "streaming" : "idle" }]}
              title={t("chat.planTitle")}
              onDismiss={() => useSessionStore.getState().dismissPlanReview(sessionId)}
            />
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
      <UserMessageNav items={userMsgItems} activeId={activeUserMsgId} onSelect={handleNavSelect} planIds={planIds} />
    </Conversation>
  )
}

export function ChatView({ sessionId }: { sessionId?: string } = {}) {
  const { mode, setMode, folders, setFolders } = useWorkspace()
  const activeSession = useActiveSession(mode)
  const explicitSession = useSessionStore((s) =>
    sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined,
  )
  const session = sessionId ? explicitSession : activeSession
  const viewMode = session?.mode ?? mode
  const messages = useSessionStore((s) =>
    session ? s.messages[session.id] ?? NO_MESSAGES : NO_MESSAGES,
  )
  const status = useSessionStatus(session?.id)
  const plan = useSessionStore((s) => (session ? s.orchestration[session.id] : undefined))
  const planReview = useSessionStore((s) => (session ? s.planReviews[session.id] : undefined))
  const pendingAsks = useSessionStore((s) => (session ? s.pendingAsks[session.id] ?? NO_ASKS : NO_ASKS))
  // IDs de mensagens de usuário que geraram planos — computado do review + mensagens
  const planMsgIds = useMemo(() => {
    const ids = new Set<string>()
    if (!planReview || !session) return ids
    if (planReview.status !== "proposed" && planReview.status !== "implementing") return ids
    const idx = messages.findIndex((m) => m.id === planReview.messageId)
    if (idx > 0 && messages[idx - 1].role === "user") ids.add(messages[idx - 1].id)
    return ids
  }, [planReview, messages, session])
  const parentSession = useSessionStore((s) =>
    session?.parentId ? s.sessions.find((x) => x.id === session.parentId) : undefined,
  )
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)
  const selectSession = useSessionStore((s) => s.selectSession)
  const initializeProviders = useProviderStore((s) => s.initialize)
  // Default de brain/simple vem das preferências de modos ativos do modo atual
  const modeDefaults = useModelModePrefs((s) => (viewMode === "code" ? s.codeActiveModes : s.chatActiveModes))
  const simpleMode = useSimpleMode(session?.id, modeDefaults.simple)
  const chatSearchOpen = useChatSearchStore((s) => s.open)

  useEffect(() => {
    void initializeProviders()
  }, [initializeProviders])

  // Carrega o histórico tanto para views explícitas (workers/painel) quanto
  // para a sessão principal. Após um reload do renderer, o status pode voltar
  // como streaming antes de a lista de mensagens ter sido hidratada; sem este
  // efeito a UI ficava vazia enquanto o engine continuava rodando.
  useEffect(() => {
    if (session?.id) void useSessionStore.getState().ensureMessages(session.id)
  }, [session?.id])

  // Fecha a busca ao trocar de sessão para não deixar resultados obsoletos visíveis
  useEffect(() => {
    useChatSearchStore.getState().close()
  }, [session?.id])

  // Sincroniza pasta da sessão (ex.: vinda do mobile) com o workspace
  const prevSessionId = useRef(session?.id)
  useEffect(() => {
    if (viewMode === "code" && session?.directory && session.id !== prevSessionId.current) {
      prevSessionId.current = session.id
      setFolders([session.directory, ...(session.extraDirectories ?? [])])
    }
  }, [session?.id, session?.directory, viewMode, setFolders])

  const isBusy = status === "submitted" || status === "streaming" || status === "cancelling"
  const hasChat = messages.length > 0
  const personaVisible = useAppearanceStore((s) => s.personaVisible)
  // Pasta alvo do card de init: a da sessão ou a selecionada no FolderSelector
  const initDirectory = session?.directory ?? (viewMode === "code" ? folders[0] : undefined)

  const prevHasChat = useRef(hasChat)
  const isBusyRef = useRef(isBusy)
  isBusyRef.current = isBusy

  const [displayCenterState, setDisplayCenterState] = useState<PersonaState>(
    hasChat ? "asleep" : "idle",
  )
  const [displayTopState, setDisplayTopState] = useState<PersonaState>(
    hasChat ? (isBusy ? "thinking" : "idle") : "asleep",
  )
  const [topVisible, setTopVisible] = useState(hasChat)
  const [centerVisible, setCenterVisible] = useState(!hasChat)
  const [centerPersonaVisible, setCenterPersonaVisible] = useState(!hasChat)
  const [chatVisible, setChatVisible] = useState(hasChat)

  useEffect(() => {
    const wasChatting = prevHasChat.current
    prevHasChat.current = hasChat
    const timers: ReturnType<typeof setTimeout>[] = []

    if (hasChat && !wasChatting) {
      // Entrando no chat: espera centro sair antes de mostrar mensagens
      setCenterVisible(true)
      setCenterPersonaVisible(true)
      setDisplayCenterState("idle")
      timers.push(setTimeout(() => setDisplayCenterState("asleep"), 50))
      timers.push(setTimeout(() => { setCenterVisible(false); setCenterPersonaVisible(false) }, 700))
      setDisplayTopState("asleep")
      setTopVisible(true)
      timers.push(setTimeout(() => setDisplayTopState(isBusyRef.current ? "thinking" : "idle"), 700))
      timers.push(setTimeout(() => setChatVisible(true), 850))
    } else if (!hasChat && wasChatting) {
      // Saindo do chat: texto aparece, persona do centro depois
      setChatVisible(false)
      setDisplayTopState(isBusyRef.current ? "thinking" : "idle")
      timers.push(setTimeout(() => {
        setDisplayTopState("asleep")
        timers.push(setTimeout(() => setTopVisible(false), 500))
      }, 50))
      setCenterVisible(true)
      setCenterPersonaVisible(false)
      setDisplayCenterState("asleep")
      timers.push(setTimeout(() => setCenterPersonaVisible(true), 300))
      timers.push(setTimeout(() => setDisplayCenterState("idle"), 1000))
    } else if (hasChat) {
      // Permanece no chat (isBusy mudou durante a transição de entrada e
      // cancelou os timers): convergem para o estado final — chat visível e
      // centro oculto. Sem isso, o estado vazio (texto + sugestões) fica
      // preso com opacidade total, aparecendo como "background" do chat.
      setChatVisible(true)
      setCenterVisible(false)
      setCenterPersonaVisible(false)
      setDisplayTopState(isBusyRef.current ? "thinking" : "idle")
    } else {
      // Permanece sem chat (isBusy mudou durante a saída do chat) — garante
      // o estado final: tudo do centro visível, topo oculto e persona acordada.
      setCenterVisible(true)
      setCenterPersonaVisible(true)
      setDisplayCenterState("idle")
      setTopVisible(false)
    }

    return () => timers.forEach(clearTimeout)
  }, [hasChat, isBusy])

  const centerPersonaState = displayCenterState
  const topPersonaState = displayTopState

  const handleChatSend = useCallback(
    (text: string, options: SendMessageOptions, files?: FilePart[]) => {
      return sendMessage("chat", text, { options, sessionId, files })
    },
    [sendMessage, sessionId],
  )

  const handleCodeSend = useCallback(
    (text: string, options: SendMessageOptions, directory: string, extraDirectories: string[], files?: FilePart[]) => {
      return sendMessage("code", text, { options, directory, extraDirectories, sessionId, files })
    },
    [sendMessage, sessionId],
  )

  const handleStop = useCallback(() => {
    if (session) stopStreaming(session.id)
  }, [session, stopStreaming])

  const handleSuggestion = useCallback(
    (suggestion: string) => {
      if (viewMode === "chat") {
        handleChatSend(suggestion, { simple: simpleMode, brain: brainEnabledFor(session?.id, useModelModePrefs.getState().chatActiveModes.brain) })
      }
    },
    [viewMode, handleChatSend, simpleMode, session?.id],
  )

  const { t } = useTranslation()
  const chatSuggestions = t("chat.suggestions.chat", { returnObjects: true }) as string[]
  const codeSuggestions = t("chat.suggestions.code", { returnObjects: true }) as string[]

  const emptyState = viewMode === "chat"
    ? { title: t("chat.empty.chatTitle"), subtitle: t("chat.empty.chatSubtitle"), suggestions: chatSuggestions }
    : { title: t("chat.empty.codeTitle"), subtitle: t("chat.empty.codeSubtitle"), suggestions: codeSuggestions }

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      {/* Breadcrumb de chat orquestrado: pai > worker */}
      {session?.parentId && (
        <div className="z-30 flex items-center gap-1 px-4 pt-2 text-xs text-muted-foreground">
          <button
            type="button"
            className="max-w-48 truncate transition-colors hover:text-foreground"
            onClick={() => {
              // Acompanha o modo do pai para a sidebar destacar a sessão certa
              const targetMode = parentSession?.mode ?? viewMode
              if (targetMode !== mode) setMode(targetMode)
              void selectSession(targetMode, session.parentId!)
            }}
          >
            {parentSession?.title ?? "Chat principal"}
          </button>
          <ChevronRight className="size-3 shrink-0" />
          <span className="max-w-64 truncate text-foreground">{session.title}</span>
        </div>
      )}
      <div className="relative flex-1">
        {topVisible && !simpleMode && personaVisible && (
          <div
            className="absolute left-1/2 z-40 -translate-x-1/2 transition-all duration-500 ease-in-out opacity-100"
            style={{
              top: "-1.7rem",
              width: "4rem",
              height: "4rem",
            }}
          >
            <Persona state={topPersonaState} className="!size-full" />
          </div>
        )}

        <div
          className={`flex h-full items-center justify-center transition-all duration-300 ease-in-out ${
            centerVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <div className="flex flex-col items-center gap-6">
            {personaVisible && (
              <div
                className="flex justify-center transition-all duration-500 ease-in-out"
                style={{
                  width: "8rem",
                  height: "8rem",
                  opacity: centerPersonaVisible ? 1 : 0,
                }}
              >
                <Persona state={centerPersonaState} className="!size-full" />
              </div>
            )}
            <div className="flex flex-col items-center gap-2">
              <p className="text-lg font-medium text-foreground">{emptyState.title}</p>
              <p className="text-sm text-muted-foreground">{emptyState.subtitle}</p>
            </div>
            <div className="grid w-full max-w-md grid-cols-2 justify-center gap-2">
              {emptyState.suggestions.map((s) => (
                <Suggestion key={s} onClick={handleSuggestion} suggestion={s} />
              ))}
            </div>
          </div>
        </div>

        <div
          className={`absolute inset-0 flex flex-col transition-all duration-500 ease-in-out ${
            chatVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <div className={`flex min-h-0 flex-1 flex-col ${topVisible && !simpleMode && personaVisible ? "pt-6" : "pt-2"}`}>
            <div className="pointer-events-none sticky top-0 z-10 h-12 bg-linear-to-b to-transparent" style={{ backgroundImage: 'linear-gradient(to bottom, var(--panel-bg, var(--background)), transparent)' }} />
            {chatSearchOpen && viewMode === "chat" && <ChatMessageSearchBar messages={messages} />}
            <ChatMessages messages={messages} isBusy={isBusy} mode={viewMode} sessionId={session?.id} sendMessage={sendMessage} planIds={planMsgIds} planReview={planReview} plan={plan} />
          </div>
        </div>
      </div>
      {/* Projeto novo no modo código: card oferece o /init automático */}
      {viewMode === "code" && initDirectory && (
        <div className="mx-auto w-full max-w-2xl pb-2">
          <InitProjectCard directory={initDirectory} sessionId={session?.id} />
        </div>
      )}
      {/* Revert ativo: barra com alterações desfeitas + botão de desfazer */}
      {session?.revert && (
        <div className="mx-auto w-full max-w-2xl pb-2">
          <RevertBar session={session} />
        </div>
      )}
      {/* Plano de orquestração proposto — aprovar/rejeitar */}
      {session && plan && plan.status === "proposed" && (
        <div className="mx-auto w-full max-w-2xl pb-2">
          <OrchestrationPlanCard sessionId={session.id} plan={plan} />
        </div>
      )}
      {/* Plano de orquestração em execução/concluído — progresso das tarefas */}
      {session && plan && (plan.status === "approved" || plan.status === "running" || plan.status === "done") && (
        <div className="mx-auto w-full max-w-2xl pb-2">
          <TaskProgress
            tasks={plan.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, mode: t.mode }))}
            title={t("chat.orchestrationTitle")}
            defaultExpanded={plan.status !== "done"}
            onDismiss={plan.status === "done" ? () => useSessionStore.getState().dismissOrchestration(session.id) : undefined}
          />
        </div>
      )}
      {/* Imagem anexada com modelo sem visão e modo Visão desligado */}
      <VisionHintCard sessionId={session?.id} />
      {/* Pedidos aguardando resposta (permissão / question), inline acima do input.
          Itens com batchId (workers em lote) agrupam num card único de submit único. */}
      {pendingAsks.length > 0 && (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 pb-2">
          {pendingAsks
            .filter((a) => !a.batchId)
            .map((ask) => (
              <AskCard key={ask.requestId} ask={ask} sessionId={session?.id} />
            ))}
          {[...new Set(pendingAsks.map((a) => a.batchId).filter(Boolean))].map((batchId) => (
            <AskCardBatch
              key={batchId}
              items={pendingAsks.filter((a) => a.batchId === batchId)}
            />
          ))}
        </div>
      )}
      {viewMode === "chat" ? (
        <ChatInput onSubmit={handleChatSend} status={status} onStop={handleStop} sessionId={session?.id} />
      ) : (
        <CodeInput
          onSubmit={handleCodeSend}
          status={status}
          onStop={handleStop}
          hasMessages={hasChat}
          sessionId={session?.id}
        />
      )}
    </div>
  )
}
