import { useMemo } from "react"
import type { ChatMessage } from "@shared/chat"
import { Shimmer } from "@/src/components/ai/shimmer"
import { MessageError } from "@/src/components/messages/shared"

/**
 * Mensagem do assistente em modo simples: apenas o texto em whitespace-pre-wrap,
 * sem markdown, citações, reasoning ou tool views — enquanto o modelo trabalha
 * sem texto visível (pensando ou rodando ferramentas), só um shimmer.
 */
export function SimpleAssistantMessage({ message, isLast, isBusy, onRetry }: {
  message: ChatMessage
  isLast: boolean
  isBusy: boolean
  onRetry?: () => void
}) {
  const text = useMemo(
    () =>
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n")
        .trim(),
    [message.parts],
  )
  const working = isLast && isBusy

  return (
    <div className="flex w-full flex-col gap-1">
      {!text && working && <Shimmer className="text-sm">Pensando…</Shimmer>}
      {text && <p className="whitespace-pre-wrap text-foreground">{text}</p>}
      {message.error && <MessageError error={message.error} onRetry={onRetry} />}
    </div>
  )
}
