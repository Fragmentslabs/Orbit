import { Fragment, useEffect } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft, Check, Cpu } from 'lucide-react-native'
import { ProviderLogo } from '~/components/ui/provider-logo'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '~/stores/settings-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

export default function ProvidersScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const selectedModel = useSettingsStore((s) => s.selectedModel)
  const catalog = useSettingsStore((s) => s.catalog)
  const connectedProviders = useSettingsStore((s) => s.connectedProviders)
  const fetchSelectedModel = useSettingsStore((s) => s.fetchSelectedModel)
  const fetchConnectedProviders = useSettingsStore((s) => s.fetchConnectedProviders)

  useEffect(() => {
    void fetchSelectedModel()
    void fetchConnectedProviders()
  }, [fetchSelectedModel, fetchConnectedProviders])

  const selectedModelName =
    selectedModel && catalog
      ? catalog[selectedModel.providerId]?.models[selectedModel.modelId]?.name ?? selectedModel.modelId
      : t('providersScreen.modelNotSet')

  return (
    <SafeScreen style={s.container}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('providersScreen.title')}</Text>
        <View style={s.headerBtn} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>{t('providersScreen.modelSection')}</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <View style={s.row}>
            <Cpu size={18} color={tokens.mutedForeground} />
            <Text style={[s.rowLabel, { color: tokens.foreground }]}>{t('providersScreen.activeModel')}</Text>
            <Text style={[s.rowValue, { color: tokens.mutedForeground }]} numberOfLines={1}>
              {selectedModelName}
            </Text>
          </View>
        </View>

        <Text style={[s.sectionLabel, { color: tokens.mutedForeground, marginTop: 24 }]}>
          {t('providersScreen.providersSection')}
        </Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          {connectedProviders.length === 0 ? (
            <Text style={[s.emptyText, { color: tokens.mutedForeground }]}>
              {t('providersScreen.none')}
            </Text>
          ) : (
            connectedProviders.map((id, i) => (
              <Fragment key={id}>
                {i > 0 && <View style={[s.divider, { backgroundColor: tokens.border }]} />}
                <View style={s.row}>
                  <ProviderLogo providerId={id} size={18} color={tokens.mutedForeground} />
                  <Text style={[s.rowName, { color: tokens.foreground }]}>{catalog?.[id]?.name ?? id}</Text>
                  <Check size={16} color={tokens.mutedForeground} />
                </View>
              </Fragment>
            ))
          )}
          {connectedProviders.length > 0 && (
            <Text style={[s.helperText, { color: tokens.mutedForeground }]}>
              {t('providersScreen.helper')}
            </Text>
          )}
        </View>
      </ScrollView>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '600' },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  divider: { height: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 15 },
  rowLabel: { fontSize: 14, flex: 1 },
  rowValue: { fontSize: 12, maxWidth: 160 },
  rowName: { fontSize: 14, flex: 1 },

  emptyText: { padding: 16, fontSize: 13, lineHeight: 19 },
  helperText: { paddingHorizontal: 16, paddingBottom: 12, fontSize: 11, paddingTop: 4 },
})
