/**
 * Tela de Rotinas — espelho do RotinasView do desktop: listagem das rotinas
 * do modo atual do workspace (a de chat lista só rotinas de chat, a de código
 * só as de código) com o botão "Nova rotina" no topo. A criação e o detalhe
 * são rotas próprias: /rotinas/nova e /rotinas/[id].
 */
import { useCallback, useEffect, useMemo } from 'react'
import { View, Text, Pressable, FlatList, ActivityIndicator, RefreshControl, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, CalendarClock, MessageSquare, Plus, Terminal } from 'lucide-react-native'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useSessionStore } from '~/stores/session-store'
import { useRotinasStore } from '~/stores/rotinas-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { RotinaCard } from '~/components/rotinas/rotina-card'

export default function RotinasScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const mode = useWorkspaceStore((s) => s.mode)
  const rotinas = useRotinasStore((s) => s.rotinas)
  const loading = useRotinasStore((s) => s.loading)
  const carregado = useRotinasStore((s) => s.carregado)
  const fetch = useRotinasStore((s) => s.fetch)

  useEffect(() => {
    void fetch()
  }, [fetch])

  // Poda das métricas órfãs na abertura: uma sessão de execução pode ter sido
  // excluída pela sidebar — como a lista é derivada das sessões, o registro
  // sobrevivente seria invisível e eterno. (Mesma regra do desktop.)
  useEffect(() => {
    void (async () => {
      await useSessionStore.getState().fetchSessions()
      useRotinasStore
        .getState()
        .podar(useSessionStore.getState().sessions.map((s) => s.id))
        .catch(() => {})
    })()
  }, [])

  // A página é do modo que a abriu: a de chat lista só rotinas de chat e a de
  // código só as de código (a sidebar separa as sessões do mesmo jeito).
  const doModo = useMemo(
    () => rotinas.filter((r) => r.mode === mode).sort((a, b) => b.criadoEm - a.criadoEm),
    [rotinas, mode],
  )

  const nova = useCallback(() => {
    router.push('/(main)/rotinas/nova')
  }, [router])

  return (
    <SafeScreen style={s.container}>
      {/* Header: título + badge do modo + botão "Nova rotina" no topo */}
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <View style={s.headerTitulo}>
          <Text style={[s.headerTitleText, { color: tokens.foreground }]}>{t('rotinas.titulo')}</Text>
          <View style={[s.modoBadge, { backgroundColor: tokens.muted }]}>
            {mode === 'chat' ? (
              <MessageSquare size={11} color={tokens.mutedForeground} />
            ) : (
              <Terminal size={11} color={tokens.mutedForeground} />
            )}
            <Text style={[s.modoBadgeText, { color: tokens.mutedForeground }]}>
              {mode === 'chat' ? t('rotinas.modo.chat') : t('rotinas.modo.code')}
            </Text>
          </View>
        </View>
        <Pressable onPress={nova} style={[s.novaBtn, { backgroundColor: tokens.primary }]}>
          <Plus size={15} color={tokens.primaryForeground} />
          <Text style={[s.novaBtnText, { color: tokens.primaryForeground }]}>{t('rotinas.lista.nova')}</Text>
        </Pressable>
      </View>

      <View style={s.body}>
        <Text style={[s.subtitulo, { color: tokens.mutedForeground }]}>
          {mode === 'chat' ? t('rotinas.subtituloChat') : t('rotinas.subtitulo')}
        </Text>

        {!carregado && loading ? (
          <View style={s.centerBox}>
            <ActivityIndicator color={tokens.primary} />
          </View>
        ) : doModo.length === 0 ? (
          <View style={s.centerBox}>
            <CalendarClock size={36} color={tokens.mutedForeground} style={{ opacity: 0.5 }} />
            <Text style={[s.emptyTitle, { color: tokens.foreground }]}>{t('rotinas.lista.vazioTitulo')}</Text>
            <Text style={[s.emptyDesc, { color: tokens.mutedForeground }]}>
              {t(mode === 'chat' ? 'rotinas.lista.vazioSubtituloChat' : 'rotinas.lista.vazioSubtitulo')}
            </Text>
            <Pressable onPress={nova} style={[s.emptyBtn, { borderColor: tokens.border }]}>
              <CalendarClock size={15} color={tokens.foreground} />
              <Text style={[s.emptyBtnText, { color: tokens.foreground }]}>{t('rotinas.lista.criarPrimeira')}</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={doModo}
            keyExtractor={(r) => r.id}
            renderItem={({ item }) => (
              <View style={{ marginBottom: 10 }}>
                <RotinaCard rotina={item} onAbrir={() => router.push(`/(main)/rotinas/${item.id}`)} />
              </View>
            )}
            contentContainerStyle={{ paddingBottom: 32 }}
            refreshControl={
              <RefreshControl refreshing={loading} onRefresh={() => void fetch()} tintColor={tokens.primary} />
            }
          />
        )}
      </View>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitulo: { minWidth: 0, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitleText: { fontSize: 16, fontWeight: '600' },
  modoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  modoBadgeText: { fontSize: 11, fontWeight: '500' },
  novaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  novaBtnText: { fontSize: 13, fontWeight: '600' },

  body: { flex: 1, paddingHorizontal: 16, paddingTop: 10 },
  subtitulo: { fontSize: 12, lineHeight: 17, marginBottom: 12 },

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
