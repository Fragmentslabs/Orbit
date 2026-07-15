import { View, Text } from 'react-native'
import { cn } from '~/lib/utils'
import type { ChatMessage, TextPart, ReasoningPart, ToolPart, AgentPart } from '@orbit/shared'

interface MessageBubbleProps {
  message: ChatMessage
}

function TextPartView({ part }: { part: TextPart }) {
  if (!part.text) return null
  return (
    <Text className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
      {part.text}
    </Text>
  )
}

function ReasoningPartView({ part }: { part: ReasoningPart }) {
  if (!part.text) return null
  return (
    <View className="mt-1 border-l-2 border-muted-foreground/30 pl-3">
      <Text className="text-xs text-muted-foreground italic" numberOfLines={3}>
        {part.text}
      </Text>
    </View>
  )
}

function ToolPartView({ part }: { part: ToolPart }) {
  return (
    <View className="mt-1 flex-row items-center gap-1.5 rounded-md bg-muted px-2 py-1">
      <View
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          part.state === 'running'
            ? 'bg-yellow-500'
            : part.state === 'error'
              ? 'bg-destructive'
              : 'bg-green-500',
        )}
      />
      <Text className="text-xs text-muted-foreground" numberOfLines={1}>
        {part.title ?? part.tool}
      </Text>
    </View>
  )
}

function AgentPartView({ part }: { part: AgentPart }) {
  return (
    <View className="mt-1 border-l-2 border-primary/40 pl-3">
      <Text className="text-xs font-medium text-muted-foreground">
        {part.label}
      </Text>
      {part.text ? (
        <Text className="text-xs text-muted-foreground italic mt-0.5" numberOfLines={3}>
          {part.text}
        </Text>
      ) : null}
    </View>
  )
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  return (
    <View
      className={cn(
        'mx-4 my-1 px-4 py-3 rounded-2xl max-w-[85%]',
        isUser
          ? 'bg-primary self-end rounded-br-sm'
          : 'bg-card border border-border self-start rounded-bl-sm',
      )}
    >
      {message.parts.map((part) => {
        switch (part.type) {
          case 'text':
            return <TextPartView key={part.id} part={part} />
          case 'reasoning':
            return <ReasoningPartView key={part.id} part={part} />
          case 'tool':
            return <ToolPartView key={part.id} part={part} />
          case 'agent':
            return <AgentPartView key={part.id} part={part} />
          case 'image':
            return null // TODO: Fase 7+ (image rendering)
          case 'file':
            return null // TODO: Fase 7+ (file rendering)
          default:
            return null
        }
      })}

      {/* Streaming cursor */}
      {message.parts.some(
        (p) => p.type === 'text' && (p as TextPart).state === 'streaming',
      ) && (
        <View className="self-start mt-1">
          <Text className="text-xs text-primary animate-pulse">▊</Text>
        </View>
      )}
    </View>
  )
}
