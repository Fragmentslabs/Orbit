import { useMemo, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Check, Clock, X } from 'lucide-react-native'
import type { Routine } from '@orbit/shared'
import { upcomingRuns } from '@orbit/shared'
import { useRoutinesStore } from '~/stores/routines-store'
import { formatTime } from '~/lib/format-time'
import { StateTile, useTokens, type RowState } from '~/components/list/parts'

const DAY_MS = 86_400_000
const DAYS = 7

const startOfDay = (ts: number) => {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

interface Event {
  key: string
  at: number
  routine: Routine
  /** Already happened (a run) or still to come. */
  kind: 'ok' | 'error' | 'running' | 'next'
}

/** The week from today: a strip of days and, under it, what ran and what is coming on the chosen one. */
export function RoutinesAgenda({ routines, onOpen }: { routines: Routine[]; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation()
  const tokens = useTokens()
  const runs = useRoutinesStore((s) => s.runs)
  const [picked, setPicked] = useState(0)
  const [now] = useState(() => Date.now())

  const week = useMemo(() => {
    const today = startOfDay(now)
    const byId = new Map(routines.map((r) => [r.id, r]))
    return Array.from({ length: DAYS }, (_, i) => {
      const from = today + i * DAY_MS
      const until = from + DAY_MS
      const events: Event[] = []
      for (const run of runs) {
        const routine = byId.get(run.routineId)
        if (routine && run.startedAt >= from && run.startedAt < until) {
          events.push({
            key: run.sessionId,
            at: run.startedAt,
            routine,
            kind: run.status === 'running' ? 'running' : run.status === 'error' ? 'error' : 'ok',
          })
        }
      }
      for (const routine of routines) {
        for (const at of upcomingRuns(routine, Math.max(from, now), until, { limit: 24, includeInactive: false })) {
          events.push({ key: `${routine.id}:${at}`, at, routine, kind: 'next' })
        }
      }
      events.sort((a, b) => a.at - b.at)
      return { from, events, upcoming: events.filter((e) => e.kind === 'next').length }
    })
  }, [routines, runs, now])

  const day = week[picked]
  const dayTitle = new Date(day.from).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <View style={{ flex: 1 }}>
      <View style={s.strip}>
        {week.map((entry, i) => {
          const active = i === picked
          const date = new Date(entry.from)
          return (
            <Pressable
              key={entry.from}
              onPress={() => setPicked(i)}
              accessibilityState={{ selected: active }}
              style={[s.day, { borderColor: tokens.border }, active && { backgroundColor: tokens.primary, borderColor: tokens.primary }]}
            >
              <Text style={{ fontSize: 11, color: active ? tokens.primaryForeground : tokens.mutedForeground }}>
                {date.toLocaleDateString(i18n.language, { weekday: 'short' }).replace('.', '')}
              </Text>
              <Text style={{ fontSize: 16, fontWeight: '600', color: active ? tokens.primaryForeground : tokens.foreground }}>
                {date.getDate()}
              </Text>
              <View
                style={[
                  s.dot,
                  { backgroundColor: entry.upcoming > 0 || entry.events.length > 0 ? (active ? tokens.primaryForeground : tokens.mutedForeground) : 'transparent' },
                ]}
              />
            </Pressable>
          )
        })}
      </View>

      <Text style={[s.dayTitle, { color: tokens.mutedForeground }]}>
        <Text style={{ color: tokens.foreground, fontWeight: '600' }}>{picked === 0 ? t('routines.agenda.today') : picked === 1 ? t('routines.agenda.tomorrow') : ''}</Text>
        {picked <= 1 ? ' · ' : ''}
        {dayTitle}
      </Text>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}>
        {day.events.length === 0 ? (
          <Text style={[s.empty, { color: tokens.mutedForeground }]}>{t('routines.agenda.nothing')}</Text>
        ) : (
          day.events.map((event) => {
            const tone: RowState = event.kind === 'running' ? 'run' : event.kind === 'error' ? 'bad' : event.kind === 'ok' ? 'ok' : 'idle'
            const Icon = event.kind === 'error' ? X : event.kind === 'ok' ? Check : Clock
            return (
              <View key={event.key} style={s.event}>
                <Text style={[s.time, { color: tokens.mutedForeground }]}>{formatTime(event.at, i18n.language)}</Text>
                <Pressable
                  onPress={() => onOpen(event.routine.id)}
                  style={[s.card, { borderColor: event.kind === 'running' ? '#3b82f680' : tokens.border, backgroundColor: tokens.card, opacity: event.kind === 'ok' ? 0.75 : 1 }]}
                >
                  <StateTile state={tone} icon={Icon} spinning={event.kind === 'running'} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '600', color: tokens.foreground }}>
                      {event.routine.title}
                    </Text>
                    <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 12.5, color: event.kind === 'error' ? tokens.destructive : tokens.mutedForeground }}>
                      {t(`routines.agenda.kind.${event.kind}`)}
                    </Text>
                  </View>
                </Pressable>
              </View>
            )
          })
        )}
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  strip: { flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10 },
  day: { flex: 1, minWidth: 0, height: 64, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  dayTitle: { paddingHorizontal: 18, paddingVertical: 8, fontSize: 12.5 },
  empty: { paddingVertical: 24, textAlign: 'center', fontSize: 13 },
  event: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  time: { width: 44, paddingTop: 16, fontSize: 12.5, textAlign: 'right', fontVariant: ['tabular-nums'] },
  card: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 14, borderWidth: 1 },
})
