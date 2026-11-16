import { useMemo, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { AnalyticsSummary } from '@orbit/shared'
import { SearchField, useTokens } from '~/components/list/parts'
import { Empty } from './usage-ui'
import { SessionRows } from './session-rows'
import { projectLabel } from './usage-utils'

const PAGE = 40

/** Every conversation of the period: search by title, filter by project, newest first. */
export function SessionsTab({ data }: { data: AnalyticsSummary }) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('all')
  const [shown, setShown] = useState(PAGE)

  const all = useMemo(() => [...(data.sessions ?? [])].sort((a, b) => b.startAt - a.startAt), [data.sessions])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter((row) => (project === 'all' || row.projectId === project) && (!q || row.title.toLowerCase().includes(q)))
  }, [all, query, project])

  if (!data.sessions) return <Empty>{t('usageScreen.sessionsNeedUpdate')}</Empty>
  if (all.length === 0) return <Empty>{t('usageScreen.noUsageInPeriod')}</Empty>

  const options = [{ id: 'all', label: t('usageScreen.sessionsAllProjects') }, ...data.byProject.map((p) => ({ id: p.projectId, label: projectLabel(p, t('usageScreen.noProject')) }))]
  return (
    <View style={{ gap: 10 }}>
      <SearchField
        value={query}
        onChange={(v) => {
          setQuery(v)
          setShown(PAGE)
        }}
        placeholder={t('usageScreen.sessionsSearch')}
      />
      {options.length > 2 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginHorizontal: -16 }} contentContainerStyle={s.chips}>
          {options.map((opt) => {
            const on = project === opt.id
            return (
              <Pressable
                key={opt.id}
                onPress={() => {
                  setProject(opt.id)
                  setShown(PAGE)
                }}
                accessibilityState={{ selected: on }}
                style={[s.chip, { borderColor: on ? tokens.muted : tokens.border }, on && { backgroundColor: tokens.muted }]}
              >
                <Text numberOfLines={1} style={{ maxWidth: 160, fontSize: 13.5, color: on ? tokens.foreground : tokens.mutedForeground }}>
                  {opt.label}
                </Text>
              </Pressable>
            )
          })}
        </ScrollView>
      ) : null}
      <Text style={{ paddingHorizontal: 2, fontSize: 12, color: tokens.mutedForeground }}>{t('usageScreen.sessionsCountOf', { shown: Math.min(shown, filtered.length), total: filtered.length })}</Text>

      <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
        <SessionRows sessions={filtered.slice(0, shown)} data={data} showDay />
      </View>

      {shown < filtered.length ? (
        <Pressable onPress={() => setShown((n) => n + PAGE)} accessibilityRole="button" style={[s.more, { borderColor: tokens.border }]}>
          <Text style={{ fontSize: 13.5, fontWeight: '500', color: tokens.foreground }}>{t('usageScreen.sessionsShowMore')}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const s = StyleSheet.create({
  chips: { flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  chip: { height: 40, paddingHorizontal: 13, borderWidth: 1, borderRadius: 99, alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: 16, overflow: 'hidden' },
  more: { alignSelf: 'center', minHeight: 44, paddingHorizontal: 20, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
})
