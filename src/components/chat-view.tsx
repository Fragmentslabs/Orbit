import { useCallback, useEffect, useRef, useState } from "react"
import { useWorkspace } from "@/lib/workspace-context"
import type { ChatMessage, SendMessageOptions } from "@/shared/chat"
import { ChatInput } from "@/src/components/chat-input"
import { CodeInput } from "@/src/components/code-input"
import { Persona, type PersonaState } from "@/src/components/ai/persona"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/src/components/ai/conversation"
import { Message, MessageContent } from "@/src/components/ai/message"
import { Suggestion } from "@/src/components/ai/suggestion"
import { ChatAssistantMessage } from "@/src/components/messages/chat-message"
import { CodeAssistantMessage } from "@/src/components/messages/code-message"
import { AssistantMessageActions, CopyAction, MessageTimestamp } from "@/src/components/messages/shared"
import { Actions } from "@/src/components/ai/actions"
import { messageText } from "@/src/lib/message-utils"
import { useActiveSession, useSessionStatus, useSessionStore } from "@/src/stores/session-store"
import { useProviderStore } from "@/src/stores/provider-store"

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

// Referência estável para o seletor do zustand (evita loop de getSnapshot)
const NO_MESSAGES: ChatMessage[] = []

function ChatMessages({ messages, isBusy, mode }: {
  messages: ChatMessage[]
  isBusy: boolean
  mode: "chat" | "code"
}) {
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id
  const AssistantMessage = mode === "chat" ? ChatAssistantMessage : CodeAssistantMessage

  return (
    <Conversation className="relative flex-1 -mt-10">
      <ConversationContent className="mx-auto w-full max-w-3xl">
        {messages.map((msg) => {
          const isLast = msg.id === lastAssistantId
          const finished = msg.role !== "assistant" || !(isLast && isBusy)
          const waiting = msg.role === "assistant" && isLast && isBusy && msg.parts.length === 0

          return (
            <Message key={msg.id} from={msg.role}>
              {msg.role === "user" ? (
                <div className="group/user-msg flex flex-col">
                  <MessageContent>
                    <p className="whitespace-pre-wrap">{messageText(msg)}</p>
                  </MessageContent>
                  <Actions className="-mb-1 items-center justify-end opacity-0 transition-opacity group-hover/user-msg:opacity-100">
                    <MessageTimestamp timestamp={msg.createdAt} />
                    <CopyAction text={messageText(msg)} />
                  </Actions>
                </div>
              ) : (
                <>
                  <MessageContent>
                    <AssistantMessage
                      message={msg}
                      isLast={isLast}
                      isBusy={isBusy}
                    />
                  </MessageContent>
                  {finished && !waiting && <AssistantMessageActions message={msg} />}
                </>
              )}
            </Message>
          )
        })}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}

export function ChatView() {
  const { mode } = useWorkspace()
  const activeSession = useActiveSession(mode)
  const messages = useSessionStore((s) =>
    activeSession ? s.messages[activeSession.id] ?? NO_MESSAGES : NO_MESSAGES,
  )
  const status = useSessionStatus(activeSession?.id)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)
  const initializeProviders = useProviderStore((s) => s.initialize)

  useEffect(() => {
    void initializeProviders()
  }, [initializeProviders])

  const isBusy = status === "submitted" || status === "streaming"
  const hasChat = messages.length > 0

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
    (text: string, options: SendMessageOptions) => {
      void sendMessage("chat", text, { options })
    },
    [sendMessage],
  )

  const handleCodeSend = useCallback(
    (text: string, options: SendMessageOptions, directory: string, extraDirectories: string[]) => {
      void sendMessage("code", text, { options, directory, extraDirectories })
    },
    [sendMessage],
  )

  const handleStop = useCallback(() => {
    if (activeSession) stopStreaming(activeSession.id)
  }, [activeSession, stopStreaming])

  const handleSuggestion = useCallback(
    (suggestion: string) => {
      if (mode === "chat") handleChatSend(suggestion, {})
    },
    [mode, handleChatSend],
  )

  const emptyState = mode === "chat"
    ? { title: "Pronto para conversar", subtitle: "Selecione um chat ou inicie uma nova conversa", suggestions: chatSuggestions }
    : { title: "Pronto para programar", subtitle: "Selecione a pasta do projeto e descreva a tarefa", suggestions: codeSuggestions }

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <div className="relative flex-1">
        <div
          className={`absolute left-1/2 z-40 -translate-x-1/2 transition-all duration-500 ease-in-out ${
            topVisible ? "opacity-100" : "opacity-0"
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
            <ChatMessages messages={messages} isBusy={isBusy} mode={mode} />
          </div>
        </div>
      </div>
      {mode === "chat" ? (
        <ChatInput onSubmit={handleChatSend} status={status} onStop={handleStop} />
      ) : (
        <CodeInput
          onSubmit={handleCodeSend}
          status={status}
          onStop={handleStop}
          hasMessages={hasChat}
        />
      )}
    </div>
  )
}
