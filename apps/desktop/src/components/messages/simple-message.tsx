import { useMemo } from "react"
import type { ChatMessage } from "@shared/chat"
import { Shimmer } from "@/src/components/ai/shimmer"
import { AssistantMarkdown, MessageError } from "@/src/components/messages/shared"
import { useTranslation } from "react-i18next"

/**
 * Mensagem do assistente em modo simples: só o texto (com markdown/code blocks),
 * sem reasoning nem tool views. Enquanto o modelo trabalha sem texto visível,
 * mostra um shimmer.
 */
export function SimpleAssistantMessage({ message, sessionId, isLast, isBusy, busyLabel, onRetry }: {
  message: ChatMessage
  sessionId?: string
  isLast: boolean
  isBusy: boolean
  /** Rótulo do estado de espera (ex.: "Tentando fallback 2/3…") — substitui "Pensando…" */
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
        <MessageError
          sessionId={sessionId}
          error={message.error}
          kind={message.errorKind}
          failedModel={{ providerId: message.providerId, modelId: message.modelId }}
          onRetry={onRetry}
        />
      )}
    </div>
  )
}
