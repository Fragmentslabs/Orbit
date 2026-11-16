import { useMemo } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import type { AnalyticsSession, AnalyticsSummary } from '@orbit/shared'
import { useSessionStore } from '~/stores/session-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { MessageSquare } from 'lucide-react-native'
import { formatCost } from '~/lib/format'
import { sessionIcon } from '~/lib/session-icon'
import { useTokens } from '~/components/list/parts'
import { formatClock, formatDayLabel, formatHours, projectLabel } from './usage-utils'

/** Opens the conversation of a history entry — in the mode it was born in. False when it no longer exists. */
export function useOpenSession() {
  const router = useRouter()
  const sessions = useSessionStore((s) => s.sessions)
  const setMode = useWorkspaceStore((s) => s.setMode)
  return (id: string): boolean => {
    const session = sessions.find((x) => x.id === id)
    if (!session) return false
    setMode(session.mode)
    router.push({ pathname: '/(main)/chat/[id]', params: { id } })
    return true
  }
}

/**
 * Rows of conversations (one per conversation and day). A conversation that no longer exists
 * (deleted after the work was done) stays in the history but cannot be opened.
 */
export function SessionRows({ sessions, data, showDay, showModel = true }: { sessions: AnalyticsSession[]; data: AnalyticsSummary; showDay?: boolean; showModel?: boolean }) {
  const { t, i18n } = useTranslation()
  const tokens = useTokens()
  const open = useOpenSession()
  const existing = useSessionStore((s) => s.sessions)
  const byId = useMemo(() => new Map(existing.map((x) => [x.id, x])), [existing])

  if (sessions.length === 0) return <Text style={[s.none, { color: tokens.mutedForeground }]}>{t('usageScreen.noUsageInPeriod')}</Text>
  return (
    <View>
      {sessions.map((row, i) => {
        const live = byId.get(row.id)
        const openable = live !== undefined
        // The type of the chat, as in the sidebar; a deleted one keeps the plain bubble.
        const Icon = live ? sessionIcon(live) : MessageSquare
        const project = data.byProject.find((p) => p.projectId === row.projectId)
        const when = showDay ? `${formatDayLabel(row.date, i18n.language)} · ${formatClock(row.startAt, i18n.language)}` : formatClock(row.startAt, i18n.language)
        const meta = [when, project ? projectLabel(project, t('usageScreen.noProject')) : null, showModel ? row.modelId : null].filter(Boolean).join(' · ')
        return (
          <Pressable
            key={`${row.id}:${row.date}`}
            disabled={!openable}
            onPress={() => open(row.id)}
            accessibilityHint={openable ? t('usageScreen.sessionsOpen') : t('usageScreen.sessionsDeleted')}
            style={({ pressed }) => [s.row, i > 0 && { borderTopWidth: 1, borderTopColor: tokens.border }, !openable && { opacity: 0.55 }, pressed && { backgroundColor: tokens.accent }]}
          >
            <Icon size={16} color={tokens.mutedForeground} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: '500', color: tokens.foreground }}>
                {row.title || t('usageScreen.untitled')}
              </Text>
              <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 11.5, color: tokens.mutedForeground }}>
                {meta}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: tokens.foreground, fontVariant: ['tabular-nums'] }}>{formatHours(row.hours)}</Text>
              <Text style={{ marginTop: 2, fontSize: 11.5, color: tokens.mutedForeground, fontVariant: ['tabular-nums'] }}>{formatCost(row.cost)}</Text>
            </View>
          </Pressable>
        )
      })}
    </View>
  )
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 14, paddingVertical: 9 },
  none: { padding: 16, fontSize: 12.5 },
})
