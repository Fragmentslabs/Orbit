/**
 * Nova task — espelho do TaskCreateDialog do desktop como rota: título,
 * descrição (o briefing completo — a task roda sem chat) e dependências.
 */
import { useState } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react-native'
import type { Esteira, Task } from '@orbit/shared'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useEsteiraStore } from '~/stores/esteira-store'
import { SeletorDependencias } from './task-detail'

export function TaskForm({
  esteira,
  onCriada,
  onCancelar,
}: {
  esteira: Esteira
  onCriada: (task: Task) => void
  onCancelar: () => void
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const tasks = useEsteiraStore((s) => s.tasksPorEsteira[esteira.id] ?? [])
  const criarTask = useEsteiraStore((s) => s.criarTask)

  const [titulo, setTitulo] = useState('')
  const [descricao, setDescricao] = useState('')
  const [dependeDe, setDependeDe] = useState<string[]>([])
  const [seletorDeps, setSeletorDeps] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const podeCriar = titulo.trim().length > 0 && !salvando

  const criar = async () => {
    if (!podeCriar) return
    setSalvando(true)
    setErro(null)
    try {
      const task = await criarTask(esteira.id, titulo.trim(), descricao.trim(), dependeDe)
      onCriada(task)
    } catch (err) {
      setErro(err instanceof Error ? err.message : String(err))
    } finally {
      setSalvando(false)
    }
  }

  const dependencias = tasks.filter((x) => dependeDe.includes(x.id))

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 64 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 6 }}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.taskTitulo')}</Text>
          <Input
            value={titulo}
            onChangeText={setTitulo}
            placeholder={t('esteira.taskTituloExemplo')}
            autoFocus
          />
        </View>

        <View style={{ gap: 6 }}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.taskDescricao')}</Text>
          <Text style={[s.dica, { color: tokens.mutedForeground }]}>{t('esteira.taskDescricaoDica')}</Text>
          <Textarea
            value={descricao}
            onChangeText={setDescricao}
            style={{ minHeight: 140, maxHeight: 280 }}
          />
        </View>

        <View style={{ gap: 6 }}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.taskDependencias')}</Text>
          <Text style={[s.dica, { color: tokens.mutedForeground }]}>{t('esteira.taskDependenciasDica')}</Text>
          {dependencias.length > 0 ? (
            <View style={s.chips}>
              {dependencias.map((dep) => (
                <View key={dep.id} style={[s.chip, { backgroundColor: tokens.muted }]}>
                  <Text style={[s.chipTexto, { color: tokens.mutedForeground }]} numberOfLines={1}>
                    {dep.titulo}
                  </Text>
                  <Pressable onPress={() => setDependeDe((prev) => prev.filter((x) => x !== dep.id))} hitSlop={8}>
                    <X size={11} color={tokens.mutedForeground} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : (
            <Text style={[s.dica, { color: tokens.mutedForeground }]}>{t('esteira.selecioneDependencias')}</Text>
          )}
          <Pressable
            onPress={() => setSeletorDeps(true)}
            disabled={tasks.length === 0}
            style={{ alignSelf: 'flex-start' }}
          >
            <Text style={[s.dica, { color: tasks.length === 0 ? tokens.mutedForeground : tokens.primary }]}>
              {tasks.length === 0 ? t('esteira.semTasksParaDependencia') : `+ ${t('esteira.adicionarDependencia')}`}
            </Text>
          </Pressable>
        </View>

        {erro && <Text style={[s.erro, { color: tokens.destructive }]}>{erro}</Text>}

        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
          <Pressable onPress={onCancelar} style={{ padding: 8 }}>
            <Text style={[s.botaoSecundario, { color: tokens.foreground }]}>{t('sidebar.cancel')}</Text>
          </Pressable>
          <Pressable
            onPress={() => void criar()}
            disabled={!podeCriar}
            style={[s.botaoPrimario, { backgroundColor: tokens.primary, opacity: podeCriar ? 1 : 0.4 }]}
          >
            {salvando ? (
              <ActivityIndicator size="small" color={tokens.primaryForeground} />
            ) : (
              <Text style={[s.botaoPrimarioTexto, { color: tokens.primaryForeground }]}>{t('esteira.criarTask')}</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>

      {seletorDeps && (
        <SeletorDependencias
          onFechar={() => setSeletorDeps(false)}
          tasks={tasks}
          selecionadas={dependeDe}
          onMudar={(ids) => setDependeDe(ids)}
        />
      )}
    </KeyboardAvoidingView>
  )
}

const s = StyleSheet.create({
  rotulo: { fontSize: 12, fontWeight: '600' },
  dica: { fontSize: 11, lineHeight: 15 },
  erro: { fontSize: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: '100%',
  },
  chipTexto: { fontSize: 11, fontWeight: '500', maxWidth: 220 },
  botaoSecundario: { fontSize: 13, fontWeight: '500' },
  botaoPrimario: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  botaoPrimarioTexto: { fontSize: 13, fontWeight: '600' },
})
