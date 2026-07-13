import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronRight, PaperclipIcon } from "lucide-react"
import { UserMessageNav } from "@/src/components/user-message-nav"
import { useWorkspace } from "@/lib/workspace-context"
import type { ChatMessage, FilePart, SendMessageOptions } from "@/shared/chat"
import { AskCard } from "@/src/components/ask-card"
import { AskCardBatch } from "@/src/components/ask-card-batch"
import { ChatInput } from "@/src/components/chat-input"
import { CodeInput } from "@/src/components/code-input"
import { Persona, type PersonaState } from "@/src/components/ai/persona"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/src/components/ai/conversation"
import { Message, MessageAttachment, MessageAttachments, MessageContent } from "@/src/components/ai/message"
import { Suggestion } from "@/src/components/ai/suggestion"
import { ChatAssistantMessage } from "@/src/components/messages/chat-message"
import { CodeAssistantMessage } from "@/src/components/messages/code-message"
import { SimpleAssistantMessage } from "@/src/components/messages/simple-message"
import { SummaryCard } from "@/src/components/messages/summary-card"
import { OrchestrationPlanCard } from "@/src/components/orchestration-plan-card"
import { PlanReviewCard } from "@/src/components/plan-review-card"
import { InitProjectCard } from "@/src/components/init-project-card"
import { RevertBar } from "@/src/components/revert-bar"
import { AssistantMessageActions, CopyAction, MessageTimestamp } from "@/src/components/messages/shared"
import { Actions } from "@/src/components/ai/actions"
import { messageText } from "@/src/lib/message-utils"
import { useActiveSession, useSessionStatus, useSessionStore, type SendConfig } from "@/src/stores/session-store"
import { brainEnabledFor } from "@/src/stores/brain-prefs"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSimpleMode } from "@/src/stores/simple-mode"

const chatSuggestions = [
  "O que você pode fazer?",
  "Me ajude a escrever um texto",
  "Explique um conceito técnico",
  "Faça um resumo de algum tópico",
]

const codeSuggestions = [
  "Revise meu código atual",
  "Explique este repositório",
  "Gere testes para este projeto",
  "Refatore algo no código",
]

// Referências estáveis para seletores do zustand (evita loop de getSnapshot)
const NO_MESSAGES: ChatMessage[] = []
const NO_ASKS: never[] = []

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

  const handleRetry = useCallback(() => {
    const prevUser = [...messages].slice(0, index).reverse().find((m) => m.role === "user")
    if (prevUser && sessionId) {
      void sendMessage(mode, messageText(prevUser), { options: {}, sessionId })
    }
  }, [messages, index, mode, sessionId, sendMessage])

  if (msg.role === "user") {
    const files = msg.parts.filter((p): p is FilePart => p.type === "file")
    return (
      <Message from="user" data-user-msg-id={msg.id}>
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
                    <span className="truncate">{file.filename ?? "Arquivo"}</span>
                  </div>
                ),
              )}
            </MessageAttachments>
          )}
          <MessageContent>
            <p className="whitespace-pre-wrap">{messageText(msg)}</p>
          </MessageContent>
          <Actions className="-mb-1 items-center justify-end opacity-0 transition-opacity group-hover/user-msg:opacity-100">
            <MessageTimestamp timestamp={msg.createdAt} />
            <CopyAction text={messageText(msg)} />
          </Actions>
        </div>
      </Message>
    )
  }

  return (
    <Message from="assistant">
      <MessageContent>
        {msg.simple ? (
          <SimpleAssistantMessage message={msg} isLast={isLast} isBusy={isBusy} onRetry={handleRetry} />
        ) : (
          <AssistantMessage
            message={msg}
            sessionId={sessionId}
            isLast={isLast}
            isBusy={isBusy}
            onRetry={handleRetry}
          />
        )}
      </MessageContent>
      {finished && !waiting && <AssistantMessageActions message={msg} sessionId={sessionId} />}
    </Message>
  )
}

function ChatMessages({ messages, isBusy, mode, sessionId, sendMessage }: {
  messages: ChatMessage[]
  isBusy: boolean
  mode: "chat" | "code"
  sessionId?: string
  sendMessage: (mode: "chat" | "code", text: string, config: SendConfig) => Promise<void>
}) {
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant" && !m.summary)?.id

  const userMsgItems = useMemo(
    () =>
      messages
        .filter((m) => m.role === "user")
        .map((m) => ({ id: m.id, text: messageText(m) })),
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
    document
      .querySelector<HTMLElement>(`[data-user-msg-id="${id}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [])

  return (
    <Conversation className="relative flex-1 -mt-10">
      <ConversationContent className="mx-auto w-full max-w-3xl">
        {messages.map((msg, index) => {
          if (msg.summary) return <SummaryCard key={msg.id} message={msg} />

          const isLast = msg.id === lastAssistantId
          const finished = msg.role !== "assistant" || !(isLast && isBusy)
          const waiting = msg.role === "assistant" && isLast && isBusy && msg.parts.length === 0

          return (
            <MessageItem
              key={msg.id}
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
          )
        })}
      </ConversationContent>
      <ConversationScrollButton />
      <UserMessageNav items={userMsgItems} activeId={activeUserMsgId} onSelect={handleNavSelect} />
    </Conversation>
  )
}

export function ChatView({ sessionId }: { sessionId?: string } = {}) {
  const { mode, setMode, folders } = useWorkspace()
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
  const parentSession = useSessionStore((s) =>
    session?.parentId ? s.sessions.find((x) => x.id === session.parentId) : undefined,
  )
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)
  const selectSession = useSessionStore((s) => s.selectSession)
  const initializeProviders = useProviderStore((s) => s.initialize)
  const simpleMode = useSimpleMode((s) => s.simple)

  useEffect(() => {
    void initializeProviders()
  }, [initializeProviders])

  // View com sessão explícita (worker no painel direito): carrega o histórico
  useEffect(() => {
    if (sessionId) void useSessionStore.getState().ensureMessages(sessionId)
  }, [sessionId])

  const isBusy = status === "submitted" || status === "streaming"
  const hasChat = messages.length > 0
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
      // Permanece no chat, apenas isBusy mudou
      setChatVisible(true)
      setDisplayTopState(isBusyRef.current ? "thinking" : "idle")
    } else {
      // Permanece sem chat — garante tudo visível
      setCenterVisible(true)
      setCenterPersonaVisible(true)
    }

    return () => timers.forEach(clearTimeout)
  }, [hasChat, isBusy])

  const centerPersonaState = displayCenterState
  const topPersonaState = displayTopState

  const handleChatSend = useCallback(
    (text: string, options: SendMessageOptions, files?: FilePart[]) => {
      void sendMessage("chat", text, { options, sessionId, files })
    },
    [sendMessage, sessionId],
  )

  const handleCodeSend = useCallback(
    (text: string, options: SendMessageOptions, directory: string, extraDirectories: string[], files?: FilePart[]) => {
      void sendMessage("code", text, { options, directory, extraDirectories, sessionId, files })
    },
    [sendMessage, sessionId],
  )

  const handleStop = useCallback(() => {
    if (session) stopStreaming(session.id)
  }, [session, stopStreaming])

  const handleSuggestion = useCallback(
    (suggestion: string) => {
      if (viewMode === "chat") {
        handleChatSend(suggestion, { simple: simpleMode, brain: brainEnabledFor(session?.id) })
      }
    },
    [viewMode, handleChatSend, simpleMode, session?.id],
  )

  const emptyState = viewMode === "chat"
    ? { title: "Pronto para conversar", subtitle: "Selecione um chat ou inicie uma nova conversa", suggestions: chatSuggestions }
    : { title: "Pronto para programar", subtitle: "Selecione a pasta do projeto e descreva a tarefa", suggestions: codeSuggestions }

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
        {/* Persona oculta em modo simples — o shimmer da mensagem já indica atividade */}
        <div
          className={`absolute left-1/2 z-40 -translate-x-1/2 transition-all duration-500 ease-in-out ${
            topVisible && !simpleMode ? "opacity-100" : "opacity-0"
          }`}
          style={{
            top: "-1.7rem",
            width: "4rem",
            height: "4rem",
          }}
        >
          <Persona state={topPersonaState} className="!size-full" />
        </div>

        <div
          className={`flex h-full items-center justify-center transition-all duration-300 ease-in-out ${
            centerVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <div className="flex flex-col items-center gap-6">
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
          <div className="flex min-h-0 flex-1 flex-col pt-6">
            <div className="pointer-events-none sticky top-0 z-10 h-12 bg-linear-to-b to-transparent" style={{ backgroundImage: 'linear-gradient(to bottom, var(--panel-bg, var(--background)), transparent)' }} />
            <ChatMessages messages={messages} isBusy={isBusy} mode={viewMode} sessionId={session?.id} sendMessage={sendMessage} />
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
      {/* Plano de orquestração proposto/em execução, inline acima do input */}
      {session && plan && (plan.status === "proposed" || plan.status === "approved" || plan.status === "running") && (
        <div className="mx-auto w-full max-w-2xl pb-2">
          <OrchestrationPlanCard sessionId={session.id} plan={plan} />
        </div>
      )}
      {/* Plano de implementação (modo plano) proposto, inline acima do input */}
      {session && planReview && planReview.status === "proposed" && (
        <div className="mx-auto w-full max-w-2xl pb-2">
          <PlanReviewCard sessionId={session.id} review={planReview} />
        </div>
      )}
      {/* Pedidos aguardando resposta (permissão / question), inline acima do input.
          Itens com batchId (workers em lote) agrupam num card único de submit único. */}
      {pendingAsks.length > 0 && (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 pb-2">
          {pendingAsks
            .filter((a) => !a.batchId)
            .map((ask) => (
              <AskCard key={ask.requestId} ask={ask} />
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
