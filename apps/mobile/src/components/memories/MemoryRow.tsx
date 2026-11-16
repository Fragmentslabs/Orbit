import { memo, useState } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { Memory } from '@orbit/shared'
import { KIND_COLOR, KIND_ICON, categoryLabel, kindLabel, lastActivity } from './meta'
import { MemoryCard } from './MemoryCard'
import { useTokens } from '~/components/list/parts'

/** "today", "yesterday" or the date — the quiet end of the row's meta line. */
function when(ts: number, locale: string, t: (key: string) => string): string {
  // Hermes has no Intl.RelativeTimeFormat, so "today"/"yesterday" come from the translations.
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(ts))) / 86_400_000)
  if (days <= 0) return t('dateSeparator.today')
  if (days === 1) return t('dateSeparator.yesterday')
  return new Date(ts).toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}

/**
 * One memory as a row of the list (kind tile, two lines of text, kind · category · when). Tapping
 * opens the full card under it — with the edit, promote and delete actions the row itself keeps out.
 */
export const MemoryRow = memo(function MemoryRow({
  memory,
  related,
  onSelectRelated,
}: {
  memory: Memory
  related: Memory[]
  onSelectRelated: (id: string) => void
}) {
  const { i18n, t } = useTranslation()
  const tokens = useTokens()
  const [open, setOpen] = useState(false)
  const color = KIND_COLOR[memory.kind]
  const Icon = KIND_ICON[memory.kind]
  const meta = [
    memory.kind === 'project' && memory.projectName ? memory.projectName : kindLabel(memory.kind),
    memory.category ? categoryLabel(memory.category) : null,
    when(lastActivity(memory), i18n.language, t),
  ].filter(Boolean)

  return (
    <View>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityState={{ expanded: open }}
        accessibilityHint={t('memoriesScreen.rowHint')}
        style={({ pressed }) => [s.row, (pressed || open) && { backgroundColor: tokens.card }]}
      >
        <View style={[s.tile, { backgroundColor: `${color}29` }]}>
          <Icon size={17} color={color} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={open ? undefined : 2} style={{ fontSize: 14, lineHeight: 20, color: tokens.foreground }}>
            {memory.text}
          </Text>
          <Text numberOfLines={1} style={{ marginTop: 4, fontSize: 12, color: tokens.mutedForeground, opacity: 0.85 }}>
            {meta.join(' · ')}
          </Text>
        </View>
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
          <MemoryCard memory={memory} related={related} onSelectRelated={onSelectRelated} />
        </View>
      ) : null}
    </View>
  )
})

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 10, paddingVertical: 11, borderRadius: 14 },
  tile: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
})
