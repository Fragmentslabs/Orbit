/**
 * Edit routine — the same RoutineForm as the creation, pre-filled with the
 * routine. Only the editable fields of the desktop: title, prompt, schedule,
 * modes and model (the mode and the folders do not change on edition).
 */
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react-native'
import { useRoutinesStore } from '~/stores/routines-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { RoutineForm } from '~/components/routines/routine-form'

export default function EditRoutineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const routine = useRoutinesStore((s) => s.routines.find((r) => r.id === id))

  if (!routine) {
    return <SafeScreen style={{ flex: 1 }}>{null}</SafeScreen>
  }

  return (
    <SafeScreen style={{ flex: 1 }}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('routines.list.edit')}</Text>
        <View style={s.headerBtn} />
      </View>
      <RoutineForm mode={routine.mode} routine={routine} onDone={() => router.back()} />
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' },
})
