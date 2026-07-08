import { useCallback, useEffect, useState } from "react"
import { useWorkspace } from "@/lib/workspace-context"
import { useChatStore } from "@/lib/chat-store"
import { ChatInput } from "@/src/components/chat-input"
import { CodeInput } from "@/src/components/code-input"
import { Persona, type PersonaState } from "@/src/components/ai/persona"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/src/components/ai/conversation"
import { Message, MessageContent, MessageResponse } from "@/src/components/ai/message"
import { Suggestions, Suggestion } from "@/src/components/ai/suggestion"

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

function getChatContent(handleSend: (text: string) => void) {
  return {
    title: "Pronto para conversar",
    subtitle: "Selecione um chat ou inicie uma nova conversa",
    suggestions: chatSuggestions,
    input: <ChatInputWrapper onSubmit={handleSend} />,
  }
}

function getCodeContent(handleSend: (text: string) => void) {
  return {
    title: "Pronto para programar",
    subtitle: "Selecione um contexto de código ou inicie um novo",
    suggestions: codeSuggestions,
    input: <CodeInput />,
  }
}

function ChatInputWrapper({ onSubmit }: { onSubmit: (text: string) => void }) {
  return (
    <ChatInput onSubmit={onSubmit} />
  )
}

function ChatMessages() {
  const activeChat = useChatStore((s) => s.getActiveChat())
  const messages = activeChat?.messages ?? []

  return (
    <Conversation className="relative flex-1">
      <ConversationContent>
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
  const [personaStage, setPersonaStage] = useState<"large" | "hiding" | "small" | "hidden">("large")
  const content = mode === "chat" ? getChatContent(handleSendMessage) : getCodeContent(handleSendMessage)
  const activeChat = useChatStore((s) => s.getActiveChat())
  const createChat = useChatStore((s) => s.createChat)
  const addMessage = useChatStore((s) => s.addMessage)
  const isProcessing = useChatStore((s) => s.isProcessing)
  const setProcessing = useChatStore((s) => s.setProcessing)

  const runPersonaSequence = useCallback(async () => {
    setPersonaStage("large")
    setPersonaState("asleep")
    await new Promise((r) => setTimeout(r, 800))
    setPersonaStage("hiding")
    await new Promise((r) => setTimeout(r, 200))
    setPersonaStage("small")
    setPersonaState("idle")
    await new Promise((r) => setTimeout(r, 300))
  }, [])

  useEffect(() => {
    if (isProcessing) {
      setPersonaState("thinking")
    } else if (activeChat && activeChat.messages.length > 0) {
      setPersonaState("idle")
    }
  }, [isProcessing, activeChat])

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

      await runPersonaSequence()

      setProcessing(true)
      setPersonaState("thinking")

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
    [activeChat, createChat, addMessage, setProcessing, runPersonaSequence],
  )

  const handleSuggestion = useCallback(
    (suggestion: string) => {
      handleSendMessage(suggestion)
    },
    [handleSendMessage],
  )

  if (!activeChat) {
    return (
      <>
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <div className="flex flex-col items-center gap-6">
            <Persona state={personaState} />
            <div className="flex flex-col items-center gap-2">
              <p className="text-lg font-medium text-foreground">
                {content.title}
              </p>
              <p className="text-sm text-muted-foreground">
                {content.subtitle}
              </p>
            </div>
            <Suggestions>
              {content.suggestions.map((s) => (
                <Suggestion
                  key={s}
                  onClick={handleSuggestion}
                  suggestion={s}
                />
              ))}
            </Suggestions>
          </div>
        </div>
        {content.input}
      </>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <ChatMessages />
      {personaStage === "small" && (
        <div className="fixed bottom-24 right-6 z-50">
          <Persona state={personaState} className="!size-16" />
        </div>
      )}
      {content.input}
    </div>
  )
}
