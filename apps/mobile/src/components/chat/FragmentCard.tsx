import { useEffect } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import type { ToolPart } from '@orbit/shared'
import { FragmentIcon } from '~/components/fragments/FragmentIcon'
import { fragmentIdOfPart } from '~/lib/fragment-ref'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useFragmentsStore } from '~/stores/fragments-store'
import { useThemeStore } from '~/stores/theme-store'

/**
 * What the agent just created, in the conversation: the fragment's name and a way to open it. The chat is
 * where it is built and edited; this card is how the person gets from "it is done" to using it.
 */
export function FragmentCard({ part }: { part: ToolPart }) {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const id = fragmentIdOfPart(part)
  const entry = useFragmentsStore((s) => (id ? s.entries.find((e) => e.id === id) : undefined))
  const loaded = useFragmentsStore((s) => s.loaded)
  const refresh = useFragmentsStore((s) => s.refresh)
  const working = part.state === 'running'
  const name = entry?.name ?? (typeof part.input?.name === 'string' ? part.input.name : t('fragments.card.created'))

  // The fragment only exists on the phone's list once the list has been read after it was made.
  const missing = !!id && !entry
  useEffect(() => {
    if (missing && !working) void refresh()
  }, [missing, working, refresh, loaded])

  if (part.state === 'error') return null

  return (
    <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={s.head}>
        <View style={[s.tile, { backgroundColor: tokens.muted }]}>
          {working ? <ActivityIndicator size="small" color={tokens.mutedForeground} /> : <FragmentIcon name={entry?.icon} size={20} color={tokens.foreground} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 14.5, fontWeight: '600', color: tokens.foreground }}>
            {name}
          </Text>
          <Text numberOfLines={1} style={{ fontSize: 11.5, color: tokens.mutedForeground }}>
            {t('fragments.card.created')}
          </Text>
        </View>
      </View>
      <View style={s.actions}>
        <Pressable
          disabled={!entry}
          onPress={() => entry && router.push({ pathname: '/(main)/fragments/[id]', params: { id: entry.id } })}
          accessibilityRole="button"
          style={[s.primary, { backgroundColor: tokens.primary, opacity: entry ? 1 : 0.5 }]}
        >
          <Text style={{ color: tokens.primaryForeground, fontWeight: '600', fontSize: 13.5 }}>{t('fragments.open')}</Text>
        </Pressable>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 16, padding: 12, gap: 12, marginVertical: 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tile: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 8 },
  primary: { flex: 1, height: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
})
