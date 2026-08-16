/**
 * Board da esteira — acordeões por fase (Pendentes → fases → Concluídas),
 * drag & drop por long-press e controle de fila automática no header.
 */
import { useEffect, useState } from 'react'
import { View, Text, Pressable, Alert, ActivityIndicator, StyleSheet } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, MoreHorizontal, Pause, Pencil, Play, Trash2 } from 'lucide-react-native'
import { useEsteiraStore } from '~/stores/esteira-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { ActionMenu, type ActionMenuItem } from '~/components/ui/action-menu'
import { BoardEsteira } from '~/components/esteira/board'
import { ErroCarregamento } from '~/components/esteira/erro-carregamento'
import { useCodeOnly } from '~/components/esteira/use-code-only'

export default function EsteiraBoardScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  useCodeOnly()

  const { id } = useLocalSearchParams<{ id: string }>()
  const esteira = useEsteiraStore((s) => s.esteiras.find((e) => e.id === id))
  const carregado = useEsteiraStore((s) => s.carregado)
  const erro = useEsteiraStore((s) => s.erro)
  const fetch = useEsteiraStore((s) => s.fetch)
  const filaLigada = useEsteiraStore((s) => s.filasLigadas[id ?? ''] ?? false)
  const alternarFila = useEsteiraStore((s) => s.alternarFila)
  const removerEsteira = useEsteiraStore((s) => s.removerEsteira)

  const [menuAberto, setMenuAberto] = useState(false)

  useEffect(() => {
    if (!carregado) void fetch()
  }, [carregado, fetch])

  // Esteira removida (daqui, do desktop ou de outra tela): volta para a lista.
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

  const menuItems: ActionMenuItem[] = [
    {
      icon: Pencil,
      label: t('esteira.editarEsteira'),
      onPress: () => router.push(`/(main)/esteira/${esteira.id}/editar`),
    },
    {
      icon: Trash2,
      label: t('esteira.removerEsteira'),
      destructive: true,
      onPress: () =>
        Alert.alert(
          t('esteira.removerEsteira'),
          t('esteira.confirmarRemocao', { nome: esteira.nome }),
          [
            { text: t('sidebar.cancel'), style: 'cancel' },
            {
              text: t('esteira.removerEsteira'),
              style: 'destructive',
              onPress: () => {
                void removerEsteira(esteira.id).then(() => router.back())
              },
            },
          ],
        ),
    },
  ]

  return (
    <SafeScreen style={{ flex: 1 }}>
      {/* Header da esteira: voltar + nome + controles */}
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn} accessibilityLabel={t('esteira.voltar')}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <View style={{ minWidth: 0, flex: 1, gap: 1 }}>
          <Text style={[s.titulo, { color: tokens.foreground }]} numberOfLines={1}>
            {esteira.nome}
          </Text>
          <Text style={[s.subtitulo, { color: tokens.mutedForeground }]} numberOfLines={1}>
            {esteira.fases.map((f) => f.nome).join(' → ')}
            {esteira.branch ? ` · ${esteira.branch}` : ''}
          </Text>
        </View>
        {/* Fila automática: ícone ghost — play cinza (desligada) / pause amarelo (ligada) */}
        <Pressable
          onPress={() => void alternarFila(esteira.id, !filaLigada)}
          accessibilityLabel={t('esteira.filaDica')}
          style={[s.headerBtn, filaLigada && { backgroundColor: tokens.muted }]}
          hitSlop={6}
        >
          {filaLigada ? (
            <Pause size={18} color={tokens.primary} />
          ) : (
            <Play size={18} color={tokens.mutedForeground} />
          )}
        </Pressable>
        <Pressable onPress={() => setMenuAberto(true)} style={s.headerBtn}>
          <MoreHorizontal size={20} color={tokens.mutedForeground} />
        </Pressable>
      </View>

      <BoardEsteira esteira={esteira} />

      <ActionMenu
        visible={menuAberto}
        onClose={() => setMenuAberto(false)}
        items={menuItems}
        anchor={{ top: 52, right: 12 }}
      />
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  titulo: { fontSize: 15, fontWeight: '600' },
  subtitulo: { fontSize: 11 },
})
