/**
 * Lista de esteiras — espelho do ListaDeEsteiras do desktop: cards com nome,
 * fases em linha, pasta do projeto e resumo de tasks. "Nova esteira" abre a
 * rota /esteira/nova; abrir um card vai para o board /esteira/[id].
 */
import { useEffect } from 'react'
import { View, Text, Pressable, FlatList, ActivityIndicator, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Layers, Plus } from 'lucide-react-native'
import { useEsteiraStore } from '~/stores/esteira-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { CardEsteira } from '~/components/esteira/card-esteira'
import { ErroCarregamento } from '~/components/esteira/erro-carregamento'
import { useCodeOnly } from '~/components/esteira/use-code-only'

export default function EsteiraListaScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  useCodeOnly()

  const esteiras = useEsteiraStore((s) => s.esteiras)
  const projetos = useEsteiraStore((s) => s.projetos)
  const tasksPorEsteira = useEsteiraStore((s) => s.tasksPorEsteira)
  const loading = useEsteiraStore((s) => s.loading)
  const carregado = useEsteiraStore((s) => s.carregado)
  const erro = useEsteiraStore((s) => s.erro)
  const fetch = useEsteiraStore((s) => s.fetch)

  useEffect(() => {
    if (!carregado) void fetch()
  }, [carregado, fetch])

  return (
    <SafeScreen style={{ flex: 1 }}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <View style={{ minWidth: 0, flex: 1, gap: 1 }}>
          <Text style={[s.titulo, { color: tokens.foreground }]}>{t('esteira.titulo')}</Text>
          <Text style={[s.subtitulo, { color: tokens.mutedForeground }]}>{t('esteira.subtitulo')}</Text>
        </View>
        <Pressable onPress={() => router.push('/(main)/esteira/nova')} style={[s.novaBtn, { backgroundColor: tokens.primary }]}>
          <Plus size={15} color={tokens.primaryForeground} />
          <Text style={[s.novaBtnTexto, { color: tokens.primaryForeground }]}>{t('esteira.novaEsteira')}</Text>
        </Pressable>
      </View>

      {erro ? (
        <ErroCarregamento />
      ) : !carregado && loading ? (
        <View style={s.centerBox}>
          <ActivityIndicator color={tokens.primary} />
        </View>
      ) : esteiras.length === 0 ? (
        <View style={s.centerBox}>
          <Layers size={36} color={tokens.mutedForeground} style={{ opacity: 0.5 }} />
          <Text style={[s.emptyTitle, { color: tokens.foreground }]}>{t('esteira.vazioTitulo')}</Text>
          <Text style={[s.emptyDesc, { color: tokens.mutedForeground }]}>{t('esteira.vazioSubtitulo')}</Text>
          <Pressable
            onPress={() => router.push('/(main)/esteira/nova')}
            style={[s.emptyBtn, { borderColor: tokens.border }]}
          >
            <Layers size={15} color={tokens.foreground} />
            <Text style={[s.emptyBtnText, { color: tokens.foreground }]}>{t('esteira.criarPrimeira')}</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={esteiras}
          keyExtractor={(e) => e.id}
          renderItem={({ item }) => (
            <View style={{ marginBottom: 10 }}>
              <CardEsteira
                esteira={item}
                projeto={projetos.find((p) => p.id === item.projetoId)}
                tasks={tasksPorEsteira[item.id] ?? []}
                onAbrir={() => router.push(`/(main)/esteira/${item.id}`)}
              />
            </View>
          )}
          contentContainerStyle={{ padding: 14, paddingBottom: 32 }}
        />
      )}
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  titulo: { fontSize: 16, fontWeight: '600' },
  subtitulo: { fontSize: 11 },
  novaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  novaBtnTexto: { fontSize: 13, fontWeight: '600' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 28 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  emptyDesc: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 6,
  },
  emptyBtnText: { fontSize: 13, fontWeight: '500' },
})
