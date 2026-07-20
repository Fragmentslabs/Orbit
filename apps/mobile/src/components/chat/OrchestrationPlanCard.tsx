import { useState } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import {
  Check,
  Square,
  CheckSquare,
  FileText,
  Globe,
  MessageSquare,
  Search,
  Terminal,
  X,
} from 'lucide-react-native'
import type { OrchestrationPlan, OrchestrationTask } from '@orbit/shared'
import { useSessionStore } from '~/stores/session-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface Props {
  sessionId: string
  plan: OrchestrationPlan
}

function TaskModeIcon({ task }: { task: OrchestrationTask }) {
  const Icon = task.mode === 'code' ? Terminal : MessageSquare
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return <Icon size={14} color={tokens.mutedForeground} />
}

function TaskChips({ task }: { task: OrchestrationTask }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const chips: { icon: typeof Search; label: string }[] = []
  if (task.options.research) chips.push({ icon: Search, label: 'Pesquisa' })
  if (task.options.browser) chips.push({ icon: Globe, label: 'Browser' })
  if (task.options.plan) chips.push({ icon: FileText, label: 'Só leitura' })
  if (chips.length === 0) return null
  return (
    <View className="flex-row items-center gap-1">
      {chips.map(({ icon: Icon, label }) => (
        <View key={label} className="flex-row items-center gap-0.5 rounded px-1 py-0.5"
          style={{ backgroundColor: tokens.card }}
        >
          <Icon size={10} color={tokens.mutedForeground} />
          <Text className="text-[10px]" style={{ color: tokens.mutedForeground }}>{label}</Text>
        </View>
      ))}
    </View>
  )
}

function TaskStatusIcon({ status }: { status: OrchestrationTask['status'] }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  switch (status) {
    case 'submitted':
    case 'streaming':
      return <ActivityIndicator size="small" color={tokens.mutedForeground} />
    case 'error':
      return <X size={14} color={tokens.destructive ?? '#ef4444'} />
    default:
      return <Check size={14} color="#10b981" />
  }
}

export function OrchestrationPlanCard({ sessionId, plan }: Props) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const approvePlan = useSessionStore((s) => s.approvePlan)
  const rejectPlan = useSessionStore((s) => s.rejectPlan)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  const proposed = plan.status === 'proposed'
  const running = plan.status === 'approved' || plan.status === 'running'
  const selectedCount = plan.tasks.length - excluded.size

  const formatCost = (cost: number) => {
    if (cost < 0.01) return '$0.00'
    return `$${cost.toFixed(4)}`
  }
  const formatTokens = (tokens: number) => {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`
    return String(tokens)
  }

  return (
    <View
      className="p-3"
      style={{
        borderRadius: 12,
        borderWidth: 2,
        borderColor: tokens.border,
        backgroundColor: tokens.muted,
      }}
    >
      <View className="flex-row items-center gap-2 mb-2">
        {running ? (
          <View className="flex-row items-center gap-1">
            <ActivityIndicator size="small" color={tokens.foreground} />
            <Text className="font-medium text-sm" style={{ color: tokens.foreground }}>Executando workers...</Text>
          </View>
        ) : (
          <Text className="font-medium text-sm" style={{ color: tokens.foreground }}>
            {proposed
              ? `Plano proposto · ${plan.tasks.length} ${plan.tasks.length === 1 ? 'tarefa' : 'tarefas'}`
              : plan.status === 'done'
                ? 'Orquestração concluída'
                : 'Plano rejeitado'}
          </Text>
        )}
      </View>

      <View className="flex-col gap-1.5">
        {plan.tasks.map((task) => (
          <View
            key={task.id}
            className="flex-row items-center gap-2 rounded-md px-2 py-1.5"
            style={[
              { backgroundColor: tokens.card, borderWidth: 1, borderColor: tokens.border },
              excluded.has(task.id) && { opacity: 0.4 },
            ]}
          >
            {proposed ? (
              <Pressable
                onPress={() =>
                  setExcluded((prev) => {
                    const next = new Set(prev)
                    if (next.has(task.id)) next.delete(task.id)
                    else next.add(task.id)
                    return next
                  })
                }
                className="p-0.5"
              >
                {excluded.has(task.id) ? (
                  <Square size={14} color={tokens.mutedForeground} />
                ) : (
                  <CheckSquare size={14} color={tokens.foreground} />
                )}
              </Pressable>
            ) : (
              <TaskStatusIcon status={task.status} />
            )}
            <TaskModeIcon task={task} />
            <Text
              className="flex-1 text-xs"
              style={{ color: tokens.foreground }}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {task.title}
            </Text>
            <TaskChips task={task} />
          </View>
        ))}
      </View>

      {plan.usage && (plan.status === 'running' || plan.status === 'approved' || plan.status === 'done') && (
        <Text className="mt-2 text-[11px]" style={{ color: tokens.mutedForeground }}>
          Custo desta orquestração: {plan.usage.cost !== undefined ? formatCost(plan.usage.cost) : '—'} (
          {formatTokens(plan.usage.input + plan.usage.output)} tokens)
        </Text>
      )}

      {proposed && (
        <View className="flex-row items-center justify-end gap-2 mt-3">
          <Pressable
            onPress={() => rejectPlan(sessionId)}
            className="px-3 py-1.5 rounded-md"
            style={{ backgroundColor: tokens.card }}
          >
            <Text className="text-xs" style={{ color: tokens.mutedForeground }}>Rejeitar</Text>
          </Pressable>
          <Pressable
            onPress={() =>
              approvePlan(
                sessionId,
                plan.id,
                plan.tasks.filter((t) => !excluded.has(t.id)).map((t) => t.id),
              )
            }
            disabled={selectedCount === 0}
            className="px-3 py-1.5 rounded-md"
            style={{ backgroundColor: selectedCount === 0 ? tokens.muted : tokens.primary }}
          >
            <Text className="text-xs font-medium" style={{ color: selectedCount === 0 ? tokens.mutedForeground : '#fff' }}>
              Aprovar e executar {selectedCount < plan.tasks.length ? `(${selectedCount})` : ''}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}
