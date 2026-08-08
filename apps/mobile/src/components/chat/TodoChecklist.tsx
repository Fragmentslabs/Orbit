import { View, Text } from 'react-native'
import { Check, Circle } from 'lucide-react-native'
import { Spinner } from '~/components/ui/spinner'
import { useTranslation } from 'react-i18next'
import type { ToolPart } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'

/**
 * Checklist viva da tool todowrite (paridade com a todo-list do desktop).
 * A última chamada da mensagem é a lista atual; chamadas anteriores (stale)
 * viram uma linha discreta com o contador.
 */

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: 'low' | 'medium' | 'high'
}

function itemsOf(part: ToolPart): TodoItem[] {
  const items = part.input?.items
  return Array.isArray(items) ? (items as TodoItem[]) : []
}

function StatusIcon({ status }: { status: TodoItem['status'] }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  if (status === 'completed') return <Check size={13} color="#10b981" />
  if (status === 'in_progress') return <Spinner size={14} color={tokens.primary} />
  return <Circle size={13} color={tokens.mutedForeground} />
}

export function TodoChecklist({ part, stale }: { part: ToolPart; stale?: boolean }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const items = itemsOf(part)
  if (items.length === 0) return null
  const done = items.filter((i) => i.status === 'completed').length

  if (stale) {
    return (
      <Text style={{ marginVertical: 4, fontSize: 11, color: tokens.mutedForeground }}>
        {t('todo.stale', { count: done, total: items.length })}
      </Text>
    )
  }

  return (
    <View
      className="my-2 w-full p-3"
      style={{
        borderRadius: 8,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: hslToRgba(tokens.card, 0.4),
        gap: 6,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: '500', color: tokens.mutedForeground }}>
        {t('todo.title', { count: done, total: items.length })}
      </Text>
      {items.map((item, i) => (
        <View key={i} className="flex-row items-start gap-2">
          <View style={{ marginTop: 2 }}>
            <StatusIcon status={item.status} />
          </View>
          <Text
            style={{
              flex: 1,
              fontSize: 12,
              fontWeight: item.status === 'in_progress' || item.status === 'pending' ? '500' : '400',
              color:
                item.status === 'in_progress'
                  ? tokens.foreground
                  : item.status === 'completed'
                    ? tokens.mutedForeground
                    : tokens.mutedForeground,
              textDecorationLine: item.status === 'completed' ? 'line-through' : undefined,
            }}
          >
            {item.content}
            {item.priority === 'high' && item.status !== 'completed' ? (
              <Text style={{ color: '#f59e0b', fontSize: 10, fontWeight: '500' }}>
                {' '}
                {t('todo.high')}
              </Text>
            ) : null}
          </Text>
        </View>
      ))}
    </View>
  )
}