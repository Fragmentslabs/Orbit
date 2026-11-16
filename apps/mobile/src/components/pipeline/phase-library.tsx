import { View, Text, FlatList, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react-native'
import type { PhaseTemplate } from '@orbit/shared'
import { StateTile, useTokens } from '~/components/list/parts'
import { templateLabel } from './pipeline-utils'

/** The phases available to any pipeline — the third tab of the page (read-only here; edited in a pipeline's form). */
export function PhaseLibrary({ templates }: { templates: PhaseTemplate[] }) {
  const { t } = useTranslation()
  const tokens = useTokens()

  return (
    <FlatList
      data={templates}
      keyExtractor={(tpl) => tpl.id}
      contentContainerStyle={{ padding: 8, paddingBottom: 24 }}
      ListEmptyComponent={<Text style={[s.empty, { color: tokens.mutedForeground }]}>{t('pipeline.phaseLibrary.empty')}</Text>}
      renderItem={({ item }) => {
        const label = templateLabel(item, t)
        return (
          <View style={s.row}>
            <StateTile state="idle" icon={Layers} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: tokens.foreground }}>
                {label.name}
              </Text>
              <Text numberOfLines={2} style={{ marginTop: 2, fontSize: 12.5, color: tokens.mutedForeground }}>
                {label.description}
              </Text>
            </View>
            {item.isDefault ? (
              <View style={[s.tag, { borderColor: tokens.border }]}>
                <Text style={{ fontSize: 11, color: tokens.mutedForeground }}>{t('pipeline.phaseLibrary.default')}</Text>
              </View>
            ) : null}
          </View>
        )
      }}
    />
  )
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 10, paddingVertical: 11 },
  tag: { borderWidth: 1, borderRadius: 99, paddingHorizontal: 9, paddingVertical: 2 },
  empty: { textAlign: 'center', padding: 24, fontSize: 13 },
})
