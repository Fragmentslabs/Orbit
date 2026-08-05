import { useMemo } from "react"
import type { ChatMessage } from "@shared/chat"
import { Shimmer } from "@/src/components/ai/shimmer"
import { AssistantMarkdown, MessageError } from "@/src/components/messages/shared"

/**
 * Mensagem do assistente em modo simples: só o texto (com markdown/code blocks),
 * sem reasoning nem tool views. Enquanto o modelo trabalha sem texto visível,
 * mostra um shimmer.
 */
export function SimpleAssistantMessage({ message, isLast, isBusy, onRetry }: {
  message: ChatMessage
  isLast: boolean
  isBusy: boolean
  onRetry?: () => void
}) {
  const textParts = useMemo(
    () => message.parts.filter((part) => part.type === "text" && part.text.trim()),
    [message.parts],
  )
  const working = isLast && isBusy

  return (
    <div className="flex w-full flex-col gap-1">
      {textParts.length === 0 && working && <Shimmer className="text-sm">Pensando…</Shimmer>}
      {textParts.map((part) => (
        <AssistantMarkdown key={part.id}>{(part as { type: "text"; text: string }).text}</AssistantMarkdown>
      ))}
      {message.error && (
        <MessageError
          error={message.error}
          kind={message.errorKind}
          failedModel={{ providerId: message.providerId, modelId: message.modelId }}
          onRetry={onRetry}
        />
      )}
    </div>
  )
}
