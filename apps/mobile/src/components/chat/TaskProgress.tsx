import { useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { Check, ChevronDown, Loader, X, MessageSquare, Terminal } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'

export interface TaskItem {
  id: string
  title: string
  status: 'idle' | 'submitted' | 'streaming' | 'error'
  mode?: 'chat' | 'code'
}

export function TaskProgress({
  tasks,
  title,
  defaultExpanded = true,
}: {
  tasks: TaskItem[]
  title?: string
  defaultExpanded?: boolean
}) {
  const { t } = useTranslation()
  const resolvedTitle = title ?? t('taskProgress.defaultTitle')
  const [expanded, setExpanded] = useState(defaultExpanded)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const total = tasks.length
  const done = tasks.filter((t) => t.status === 'idle').length
  const running = tasks.some((t) => t.status === 'submitted' || t.status === 'streaming')
  const progress = total > 0 ? Math.round((done / total) * 100) : 0

  if (total === 0) return null

  return (
    <View
      className="rounded-xl"
      style={{
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: hslToRgba(tokens.muted!, 0.3),
      }}
    >
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        className="flex-row items-center gap-2 px-3 py-2"
      >
        <ChevronDown
          size={12}
          color={tokens.mutedForeground}
          style={{ transform: expanded ? undefined : [{ rotate: '-90deg' }] }}
        />
        {running ? (
          <Loader size={14} color={tokens.primary} />
        ) : (
          <Check size={14} color="#10b981" />
        )}
        <Text className="text-xs font-medium flex-shrink" style={{ color: tokens.foreground, flexShrink: 1 }}>
          {running ? t('taskProgress.inProgress', { title: resolvedTitle }) : t('taskProgress.completed', { title: resolvedTitle })}
        </Text>
        <Text className="text-xs" style={{ color: tokens.mutedForeground }}>
          {done}/{total}
        </Text>
        <View
          className="ml-auto h-1.5 rounded-full overflow-hidden"
          style={{ minWidth: 64, backgroundColor: tokens.muted! }}
        >
          <View
            className="h-full rounded-full"
            style={{
              width: `${progress}%`,
              backgroundColor: tokens.primary,
            }}
          />
        </View>
      </Pressable>

      {expanded && (
        <View className="px-1 pb-1.5 pt-1" style={{ borderTopWidth: 1, borderTopColor: tokens.border }}>
          {tasks.map((task) => {
            const isDone = task.status === 'idle'
            return (
              <View
                key={task.id}
                className="flex-row items-center gap-2 px-2 py-1 rounded-md"
                style={{ opacity: isDone ? 0.6 : 1 }}
              >
                <TaskIcon status={task.status} tokens={tokens} />
                {task.mode === 'code' ? (
                  <Terminal size={12} color={tokens.mutedForeground} />
                ) : task.mode === 'chat' ? (
                  <MessageSquare size={12} color={tokens.mutedForeground} />
                ) : null}
                <Text
                  className="text-xs flex-1"
                  style={{
                    color: isDone ? tokens.mutedForeground : tokens.foreground,
                    textDecorationLine: isDone ? 'line-through' : undefined,
                  }}
                  numberOfLines={1}
                >
                  {task.title}
                </Text>
              </View>
            )
          })}
        </View>
      )}
    </View>
  )
}

function TaskIcon({
  status,
  tokens,
}: {
  status: TaskItem['status']
  tokens: ReturnType<typeof getThemeTokens>
}) {
  const size = 14
  switch (status) {
    case 'submitted':
    case 'streaming':
      return <Loader size={size} color={tokens.primary} />
    case 'error':
      return <X size={size} color="#ef4444" />
    case 'idle':
      return <Check size={size} color="#10b981" />
    default:
      return (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 1,
            borderColor: tokens.mutedForeground + '50',
          }}
        />
      )
  }
}
