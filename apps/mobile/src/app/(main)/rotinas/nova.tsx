/**
 * Nova rotina — espelho do CriarRotinaDialog do desktop, como rota: o
 * RotinaForm cuida das duas etapas (descrever → gerar → revisar). A rotina
 * nasce no modo atual do workspace e não troca depois.
 */
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react-native'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { RotinaForm } from '~/components/rotinas/rotina-form'

export default function NovaRotinaScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const mode = useWorkspaceStore((s) => s.mode)

  return (
    <SafeScreen style={{ flex: 1 }}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('rotinas.criar.titulo')}</Text>
        <View style={s.headerBtn} />
      </View>
      <RotinaForm
        mode={mode}
        onConcluida={(rotina) => router.replace(`/(main)/rotinas/${rotina.id}`)}
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
