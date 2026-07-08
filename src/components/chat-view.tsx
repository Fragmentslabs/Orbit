import { useCallback, useEffect, useState } from "react"
import { useWorkspace } from "@/lib/workspace-context"
import { useChatStore } from "@/lib/chat-store"
import { ChatInput } from "@/src/components/chat-input"
import { CodeInput } from "@/src/components/code-input"
import { Persona, type PersonaState } from "@/src/components/ai/persona"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/src/components/ai/conversation"
import { Message, MessageContent, MessageResponse } from "@/src/components/ai/message"
import { Suggestion } from "@/src/components/ai/suggestion"

const chatSuggestions = [
  "O que você pode fazer?",
  "Me ajude a escrever um texto",
  "Explique um conceito técnico",
  "Faça um resumo de algum tópico",
]

function getChatContent(handleSend: (text: string) => void) {
  return {
    title: "Pronto para conversar",
    subtitle: "Selecione um chat ou inicie uma nova conversa",
    suggestions: chatSuggestions,
    input: <ChatInputWrapper onSubmit={handleSend} />,
  }
}

function getCodeContent(_handleSend: (text: string) => void) {
  return {
    title: "Pronto para programar",
    subtitle: "Selecione um contexto de código ou inicie um novo",
    suggestions: [
      "Revise meu código atual",
      "Explique este repositório",
      "Gere testes para este projeto",
      "Refatore algo no código",
    ],
    input: <CodeInput />,
  }
}

function ChatInputWrapper({ onSubmit }: { onSubmit: (text: string) => void }) {
  return <ChatInput onSubmit={onSubmit} />
}

function ChatMessages() {
  const activeChat = useChatStore((s) => s.getActiveChat())
  const messages = activeChat?.messages ?? []

  return (
    <Conversation className="relative flex-1">
      <ConversationContent className="px-80">
        {messages.map((msg) => (
          <Message key={msg.id} from={msg.role}>
            <MessageContent>
              {msg.role === "assistant" ? (
                <MessageResponse>{msg.content}</MessageResponse>
              ) : (
                <p>{msg.content}</p>
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
  const [personaState, setPersonaState] = useState<PersonaState>("idle")
  const [hasChat, setHasChat] = useState(false)
  const activeChat = useChatStore((s) => s.getActiveChat())
  const createChat = useChatStore((s) => s.createChat)
  const addMessage = useChatStore((s) => s.addMessage)
  const isProcessing = useChatStore((s) => s.isProcessing)
  const setProcessing = useChatStore((s) => s.setProcessing)

  useEffect(() => {
    if (activeChat && activeChat.messages.length > 0) setHasChat(true)
  }, [activeChat])

  useEffect(() => {
    if (isProcessing) {
      setPersonaState("thinking")
    } else if (hasChat) {
      setPersonaState("idle")
    }
  }, [isProcessing, hasChat])

  const handleSendMessage = useCallback(
    async (text: string) => {
      const chatId = activeChat?.id ?? createChat()

      const userMsg = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: text,
        createdAt: new Date(),
      }
      addMessage(chatId, userMsg)

      setHasChat(true)
      setPersonaState("thinking")
      await new Promise((r) => setTimeout(r, 100))

      setProcessing(true)

      const assistantMsg = {
        id: crypto.randomUUID(),
        role: "assistant" as const,
        content:
          "Esta é uma resposta de exemplo. Em breve a integração com a IA estará funcionando.",
        createdAt: new Date(),
      }
      await new Promise((r) => setTimeout(r, 1500))
      addMessage(chatId, assistantMsg)
      setProcessing(false)
      setPersonaState("idle")
    },
    [activeChat, createChat, addMessage, setProcessing],
  )

  const content = mode === "chat" ? getChatContent(handleSendMessage) : getCodeContent(handleSendMessage)

  const handleSuggestion = useCallback(
    (suggestion: string) => handleSendMessage(suggestion),
    [handleSendMessage],
  )

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="relative flex-1">
        <div
          className="absolute left-1/2 z-40 -translate-x-1/2 transition-all duration-700 ease-in-out"
          style={{
            top: hasChat ? "1rem" : "33%",
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
              <p className="text-lg font-medium text-foreground">{content.title}</p>
              <p className="text-sm text-muted-foreground">{content.subtitle}</p>
            </div>
            <div className="flex w-full max-w-md flex-wrap justify-center gap-2">
              {content.suggestions.map((s) => (
                <Suggestion key={s} onClick={handleSuggestion} suggestion={s} />
              ))}
            </div>
          </div>
        </div>

        {hasChat && (
          <div className="absolute inset-0 flex flex-col transition-all duration-500 ease-in-out">
            <div className="flex-1 pt-20">
              <ChatMessages />
            </div>
          </div>
        )}
      </div>
      {content.input}
    </div>
  )
}
