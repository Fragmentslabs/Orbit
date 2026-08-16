/**
 * Card da lista de esteiras — espelho do ListaDeEsteiras do desktop: nome,
 * fases em linha, pasta do projeto e resumo de tasks, com indicadores de
 * execução/erro.
 */
import { memo } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Folder, Layers, Loader2 } from 'lucide-react-native'
import type { Esteira, Projeto, Task } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { Spin } from '~/components/ui/spin'

export const CardEsteira = memo(function CardEsteira({
  esteira,
  projeto,
  tasks,
  onAbrir,
}: {
  esteira: Esteira
  projeto?: Projeto
  tasks: Task[]
  onAbrir: () => void
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const emAndamento = tasks.filter((x) => x.status === 'em_progresso').length
  const concluidas = tasks.filter((x) => x.status === 'concluida').length
  const comErro = tasks.some((x) => x.pausaMotivo === 'erro')

  return (
    <Pressable
      onPress={onAbrir}
      style={[s.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}
    >
      <View style={s.linha}>
        <Layers size={15} color={tokens.mutedForeground} />
        <Text style={[s.nome, { color: tokens.foreground }]} numberOfLines={1}>
          {esteira.nome}
        </Text>
        {emAndamento > 0 && (
          <Spin>
            <Loader2 size={13} color={tokens.primary} />
          </Spin>
        )}
        {comErro && <View style={[s.ponto, { backgroundColor: tokens.destructive }]} />}
        {concluidas > 0 && <View style={[s.ponto, { backgroundColor: '#eab308' }]} />}
      </View>

      <Text style={[s.fases, { color: tokens.mutedForeground }]} numberOfLines={1}>
        {esteira.fases.map((f) => f.nome).join(' → ')}
      </Text>

      {projeto && projeto.pastas.length > 0 && (
        <View style={s.linha}>
          <Folder size={12} color={tokens.mutedForeground} />
          <Text style={[s.pasta, { color: tokens.mutedForeground }]} numberOfLines={1}>
            {projeto.pastas[0]}
            {projeto.pastas.length > 1 && ` +${projeto.pastas.length - 1}`}
          </Text>
        </View>
      )}

      <Text style={[s.resumo, { color: tokens.mutedForeground }]}>
        {t('esteira.tasksResumo', { total: tasks.length, concluidas })}
        {esteira.branch ? ` · ${esteira.branch}` : ''}
      </Text>
    </Pressable>
  )
})

const s = StyleSheet.create({
  card: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 6 },
  linha: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  nome: { flex: 1, fontSize: 14, fontWeight: '600' },
  ponto: { width: 6, height: 6, borderRadius: 3 },
  fases: { fontSize: 11 },
  pasta: { flex: 1, fontSize: 11 },
  resumo: { fontSize: 11 },
})
