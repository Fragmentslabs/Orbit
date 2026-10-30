import { useMemo } from "react"
import type { ChatMessage } from "@shared/chat"
import { Shimmer } from "@/src/components/ai/shimmer"
import { AssistantMarkdown, MessageError } from "@/src/components/messages/shared"
import { useTranslation } from "react-i18next"

/**
 * Assistant message in simple mode: only the text (with markdown/code blocks),
 * without reasoning or tool views. While the model works without visible text,
 * it shows a shimmer.
 */
export function SimpleAssistantMessage({ message, sessionId, isLast, isBusy, busyLabel, onRetry }: {
  message: ChatMessage
  sessionId?: string
  isLast: boolean
  isBusy: boolean
  /** Label of the waiting state (e.g. "Trying fallback 2/3…") — it replaces "Thinking…" */
  busyLabel?: string
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  const textParts = useMemo(
    () => message.parts.filter((part) => part.type === "text" && part.text.trim()),
    [message.parts],
  )
  const working = isLast && isBusy

  return (
    <div className="flex w-full flex-col gap-1">
      {textParts.length === 0 && working && <Shimmer className="text-sm">{busyLabel ?? t("chat.thinking")}</Shimmer>}
      {textParts.map((part) => (
        <AssistantMarkdown key={part.id}>{(part as { type: "text"; text: string }).text}</AssistantMarkdown>
      ))}
      {message.error && (
        // Only in the last one: the retry reruns the turn over the user message,
        // and in an old reply that would discard what came after it.
        <MessageError
          sessionId={sessionId}
          error={message.error}
          kind={message.errorKind}
          attempts={message.attempts}
          failedModel={{ providerId: message.providerId, modelId: message.modelId }}
          onRetry={isLast ? onRetry : undefined}
        />
      )}
    </div>
  )
}
