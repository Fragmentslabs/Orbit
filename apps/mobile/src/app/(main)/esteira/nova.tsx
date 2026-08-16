/**
 * Nova esteira — espelho do EsteiraCreateDialog do desktop, como rota: o
 * EsteiraForm cria o projeto (dono das pastas) junto com a esteira. Ao
 * concluir, abre direto o board da esteira criada.
 */
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { EsteiraForm } from '~/components/esteira/esteira-form'
import { useCodeOnly } from '~/components/esteira/use-code-only'

export default function NovaEsteiraScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  useCodeOnly()

  return (
    <SafeScreen style={{ flex: 1 }}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('esteira.novaEsteira')}</Text>
        <View style={s.headerBtn} />
      </View>
      <EsteiraForm
        onConcluida={(esteira) => router.replace(`/(main)/esteira/${esteira.id}`)}
        onCancelar={() => router.back()}
      />
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
