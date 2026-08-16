/**
 * Detalhe da task — espelho do TaskModal do desktop como tela: anotações por
 * fase, execução ao vivo, telemetria, dependências e ações.
 */
import { useEffect } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ArrowLeft } from 'lucide-react-native'
import { useEsteiraStore, SEM_TASKS } from '~/stores/esteira-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { TaskDetail } from '~/components/esteira/task-detail'
import { ErroCarregamento } from '~/components/esteira/erro-carregamento'
import { useCodeOnly } from '~/components/esteira/use-code-only'

export default function TaskDetalheScreen() {
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  useCodeOnly()

  const { id, taskId } = useLocalSearchParams<{ id: string; taskId: string }>()
  const esteira = useEsteiraStore((s) => s.esteiras.find((e) => e.id === id))
  const tasks = useEsteiraStore((s) => s.tasksPorEsteira[id ?? ''] ?? SEM_TASKS)
  const task = tasks.find((x) => x.id === taskId)
  const carregado = useEsteiraStore((s) => s.carregado)
  const erro = useEsteiraStore((s) => s.erro)
  const fetch = useEsteiraStore((s) => s.fetch)

  useEffect(() => {
    if (!carregado) void fetch()
  }, [carregado, fetch])

  // Esteira ou task removida: volta para o board.
  useEffect(() => {
    if (carregado && (!esteira || !task)) router.back()
  }, [carregado, esteira, task, router])

  if (!esteira || !task) {
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
        <Text style={[s.headerTitle, { color: tokens.foreground }]} numberOfLines={1}>
          {task.titulo}
        </Text>
        <View style={s.headerBtn} />
      </View>
      <TaskDetail key={task.id} esteira={esteira} task={task} onFechar={() => router.back()} />
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
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '600' },
})
