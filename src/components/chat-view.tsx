import { useCallback, useEffect } from "react"
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

function userText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<ChatMessage["parts"][number], { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
}

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
        {messages.map((msg) => (
          <Message key={msg.id} from={msg.role}>
            <MessageContent>
              {msg.role === "assistant" ? (
                <AssistantMessage
                  message={msg}
                  isLast={msg.id === lastAssistantId}
                  isBusy={isBusy}
                />
              ) : (
                <p>{userText(msg)}</p>
              )}
            </MessageContent>
          </Message>
        ))}
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
  const personaState: PersonaState = isBusy ? "thinking" : "idle"

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
          className="absolute left-1/2 z-40 -translate-x-1/2 transition-all duration-700 ease-in-out"
          style={{
            top: hasChat ? "-1.7rem" : "33%",
            width: hasChat ? "4rem" : "8rem",
            height: hasChat ? "4rem" : "8rem",
          }}
        >
          <Persona state={personaState} className="!size-full" />
        </div>

        <div
          className={`flex h-full items-center justify-center transition-all duration-500 ease-in-out ${
            hasChat ? "opacity-0 pointer-events-none" : "opacity-100"
          }`}
        >
          <div className="flex flex-col items-center gap-6 pt-24">
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

        {hasChat && (
          <div className="absolute inset-0 flex flex-col transition-all duration-500 ease-in-out">
            <div className="flex min-h-0 flex-1 flex-col pt-6">
              <div className="pointer-events-none sticky top-0 z-10 h-12 bg-linear-to-b from-background  to-transparent" />
              <ChatMessages messages={messages} isBusy={isBusy} mode={mode} />
            </div>
          </div>
        )}
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
