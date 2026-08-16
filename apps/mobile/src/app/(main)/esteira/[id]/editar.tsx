/**
 * Editar esteira — mesmo EsteiraForm da criação, com as fases reais da
 * esteira (já são cópias, D4): preserva id, tasks e histórico.
 */
import { useEffect } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react-native'
import { useEsteiraStore } from '~/stores/esteira-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { EsteiraForm } from '~/components/esteira/esteira-form'
import { ErroCarregamento } from '~/components/esteira/erro-carregamento'
import { useCodeOnly } from '~/components/esteira/use-code-only'

export default function EditarEsteiraScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  useCodeOnly()

  const { id } = useLocalSearchParams<{ id: string }>()
  const esteira = useEsteiraStore((s) => s.esteiras.find((e) => e.id === id))
  const carregado = useEsteiraStore((s) => s.carregado)
  const erro = useEsteiraStore((s) => s.erro)
  const fetch = useEsteiraStore((s) => s.fetch)

  useEffect(() => {
    if (!carregado) void fetch()
  }, [carregado, fetch])

  useEffect(() => {
    if (carregado && !esteira) router.back()
  }, [carregado, esteira, router])

  if (!esteira) {
    return (
      <SafeScreen style={{ flex: 1 }}>
        {erro ? (
          <ErroCarregamento />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={tokens.primary} />
          </View>
        )}
      </SafeScreen>
    )
  }

  return (
    <SafeScreen style={{ flex: 1 }}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('esteira.editarEsteira')}</Text>
        <View style={s.headerBtn} />
      </View>
      <EsteiraForm editando={esteira} onConcluida={() => router.back()} onCancelar={() => router.back()} />
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
