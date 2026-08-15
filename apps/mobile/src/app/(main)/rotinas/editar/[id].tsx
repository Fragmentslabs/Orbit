/**
 * Editar rotina — o mesmo RotinaForm da criação, pré-preenchido com a rotina.
 * Só os campos editáveis do desktop: título, prompt, agenda, modos e modelo
 * (o modo e as pastas não mudam na edição).
 */
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react-native'
import { useRotinasStore } from '~/stores/rotinas-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { RotinaForm } from '~/components/rotinas/rotina-form'

export default function EditarRotinaScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const rotina = useRotinasStore((s) => s.rotinas.find((r) => r.id === id))

  if (!rotina) {
    return <SafeScreen style={{ flex: 1 }}>{null}</SafeScreen>
  }

  return (
    <SafeScreen style={{ flex: 1 }}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('rotinas.lista.editar')}</Text>
        <View style={s.headerBtn} />
      </View>
      <RotinaForm mode={rotina.mode} rotina={rotina} onConcluida={() => router.back()} />
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
