import { useEffect } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft, ChevronRight, ListRestart, Plus } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useModelRotationStore, MAX_ROTATION_SLOTS } from '~/stores/model-rotation-store'

/**
 * Lista das rotações de modelo (espelho da coluna esquerda do modal do
 * desktop). O split-view de lá não cabe no celular: a lista é a tela e o
 * editor é a tela seguinte (`rotations/[id]`).
 *
 * As rotações vivem no desktop — aqui a tela só reflete o store, que
 * sincroniza nos dois sentidos (ver model-rotation-store).
 */
export default function RotationsScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const rotations = useModelRotationStore((s) => s.rotations)
  const hydrated = useModelRotationStore((s) => s.hydrated)
  const hydrate = useModelRotationStore((s) => s.hydrate)
  const create = useModelRotationStore((s) => s.create)

  useEffect(() => {
    if (!hydrated) void hydrate()
  }, [hydrated, hydrate])

  const handleCreate = () => {
    const rotation = create(t('rotation.newName'))
    router.push(`/(main)/rotations/${rotation.id}`)
  }

  return (
    <SafeScreen>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('rotation.title')}</Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('rotation.description')}</Text>

        <Pressable
          onPress={handleCreate}
          style={({ pressed }) => [
            s.newBtn,
            { borderColor: tokens.border, backgroundColor: pressed ? tokens.muted : 'transparent' },
          ]}
        >
          <Plus size={16} color={tokens.foreground} />
          <Text style={{ fontSize: 14, fontWeight: '600', color: tokens.foreground }}>
            {t('rotation.new')}
          </Text>
        </Pressable>

        {rotations.length === 0 ? (
          <View style={s.empty}>
            <ListRestart size={22} color={tokens.mutedForeground} />
            <Text style={[s.emptyTitle, { color: tokens.foreground }]}>{t('rotation.empty')}</Text>
            <Text style={[s.hint, { color: tokens.mutedForeground, textAlign: 'center' }]}>
              {t('rotation.emptyHint')}
            </Text>
          </View>
        ) : (
          <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
            {rotations.map((rotation, index) => (
              <View key={rotation.id}>
                {index > 0 && <View style={[s.divider, { backgroundColor: tokens.border }]} />}
                <Pressable
                  onPress={() => router.push(`/(main)/rotations/${rotation.id}`)}
                  style={({ pressed }) => [s.row, pressed && { backgroundColor: tokens.muted }]}
                >
                  <ListRestart size={18} color={tokens.mutedForeground} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text numberOfLines={1} style={{ fontSize: 14, color: tokens.foreground }}>
                      {rotation.name}
                    </Text>
                    <Text style={{ fontSize: 11, color: tokens.mutedForeground }}>
                      {t('rotation.slotsLabel', { count: rotation.models.length })}
                    </Text>
                  </View>
                  <ChevronRight size={16} color={tokens.mutedForeground} />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        <Text style={[s.hint, { color: tokens.mutedForeground, marginTop: 12 }]}>
          {t('rotation.maxHint', { max: MAX_ROTATION_SLOTS })}
        </Text>
      </ScrollView>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
  backBtn: { padding: 6, borderRadius: 8 },
  headerTitle: { fontSize: 16, fontWeight: '600' },
  hint: { fontSize: 11, lineHeight: 16, opacity: 0.7 },
  newBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', marginTop: 16, marginBottom: 16 },
  card: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  divider: { height: 1 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 32, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 14, fontWeight: '600' },
})
