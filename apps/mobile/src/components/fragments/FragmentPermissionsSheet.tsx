import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { FragmentPhoneEntry } from '@orbit/shared'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { useTokens } from '~/components/list/parts'
import { capabilityRows } from '~/lib/fragment-permissions'
import { useFragmentsStore } from '~/stores/fragments-store'

/**
 * What the fragment asked for and what the person allowed, with a switch for each: the phone's copy of the
 * desktop's Permissions section. The switch is the person's click and the desktop's rules apply — an
 * imported fragment nobody reviewed cannot be switched on (off is always possible), and turning
 * notifications off cancels the ones it had scheduled.
 */
export function FragmentPermissionsSheet({ entry, open, onClose }: { entry: FragmentPhoneEntry; open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const grant = useFragmentsStore((s) => s.grant)
  const rows = capabilityRows(entry)

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={<Text style={[s.title, { color: tokens.foreground }]}>{t('fragments.permissions')}</Text>}
    >
      <ScrollView>
        {rows.length === 0 ? <Text style={[s.empty, { color: tokens.mutedForeground }]}>{t('fragments.permissionsEmpty')}</Text> : null}
        {rows.map((row) => (
          <View key={row.capability} style={[s.row, { borderBottomColor: tokens.border }]}>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={{ fontSize: 14.5, fontWeight: '500', color: tokens.foreground }}>{t(`fragments.cap.${row.capability}`)}</Text>
              {row.access ? <Text style={{ fontSize: 12, color: tokens.mutedForeground }}>{row.access}</Text> : null}
              {row.desktopOnly ? <Text style={{ fontSize: 12, color: tokens.mutedForeground }}>{t('fragments.desktopOnly')}</Text> : null}
              {row.locked ? <Text style={{ fontSize: 12, color: tokens.mutedForeground }}>{t('fragments.locked')}</Text> : null}
            </View>
            <Switch
              value={row.granted}
              disabled={row.desktopOnly || row.locked}
              onValueChange={(on) => void grant(entry.id, row.capability, on)}
              trackColor={{ false: tokens.muted, true: tokens.primary }}
              thumbColor={tokens.foreground}
            />
          </View>
        ))}
      </ScrollView>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '600', paddingBottom: 8 },
  empty: { fontSize: 13, paddingVertical: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
})
