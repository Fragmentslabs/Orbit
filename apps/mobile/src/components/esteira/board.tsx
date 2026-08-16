/**
 * Board da esteira — layout vertical em acordeões (decisão mobile): uma
 * seção por fase, recolhível, com as tasks passando entre elas. O drag & drop
 * (long-press) leva pendentes para qualquer fase e quem já começou só para
 * frente. Rodapé com as métricas da esteira (calculadas no app, sem request).
 */
import { useCallback, useMemo, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useRouter } from 'expo-router'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  GitCommit,
  Loader2,
  Plus,
} from 'lucide-react-native'
import { Droppable } from 'react-native-reanimated-dnd'
import type { Esteira, Task } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useEsteiraStore, SEM_TASKS } from '~/stores/esteira-store'
import { formatCost, formatDuration, formatTokens } from '~/lib/format'
import { Spin } from '~/components/ui/spin'
import { TaskCard } from './task-card'
import { BoardDragProvider, CartaoArrastavel, useBoardDrag } from './board-drag'
import { dependenciaBloqueante, fasesValidasParaDrop, proximaDaFila } from './esteira-utils'

export function BoardEsteira({ esteira }: { esteira: Esteira }) {
  return (
    <BoardDragProvider>
      <CorpoBoard esteira={esteira} />
    </BoardDragProvider>
  )
}

function CorpoBoard({ esteira }: { esteira: Esteira }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const router = useRouter()
  const { registrarScrollRef, registrarViewport, registrarScrollOffset, arrastando } = useBoardDrag()

  const tasks = useEsteiraStore((s) => s.tasksPorEsteira[esteira.id] ?? SEM_TASKS)
  const filaLigada = useEsteiraStore((s) => s.filasLigadas[esteira.id] ?? false)
  const progresso = useEsteiraStore((s) => s.progresso)
  const iniciarTask = useEsteiraStore((s) => s.iniciarTask)
  const pausarTask = useEsteiraStore((s) => s.pausarTask)
  const retomarTask = useEsteiraStore((s) => s.retomarTask)

  const [expandidas, setExpandidas] = useState<Record<string, boolean>>({ pendentes: true, concluidas: false })
  const alternar = (id: string) => setExpandidas((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }))

  const abrir = useCallback(
    (taskId: string) => {
      router.push({ pathname: '/(main)/esteira/[id]/task/[taskId]', params: { id: esteira.id, taskId } })
    },
    [router, esteira.id],
  )

  // Soltar numa fase inicia a task nela. "Pendentes" e "Concluídas" não têm
  // ação de drop (a conclusão é da engine) — só valem como zonas para o
  // card voltar ao lugar.
  const aoSoltar = useCallback(
    (zonaId: string, task: Task) => {
      if (!zonaId.startsWith('fase:')) return
      const indice = Number(zonaId.slice('fase:'.length))
      if (!fasesValidasParaDrop(task, esteira.fases.length).includes(indice)) return
      void iniciarTask(esteira.id, task.id, indice)
    },
    [esteira, iniciarTask],
  )

  // Regra do board: pendente vai para qualquer fase; quem já começou só para
  // frente; concluída não arrasta (nem solta em lugar nenhum).
  const dropPermitido = useCallback(
    (secaoId: string, task: Task) => {
      if (secaoId === 'pendentes') return task.status === 'pendente'
      if (secaoId === 'concluidas') return false
      const indice = Number(secaoId.slice('fase:'.length))
      return fasesValidasParaDrop(task, esteira.fases.length).includes(indice)
    },
    [esteira.fases.length],
  )

  const secoes = useMemo(() => {
    const pendentes = tasks.filter((x) => x.status === 'pendente')
    const fases = esteira.fases.map((fase, indice) => ({
      id: `fase:${indice}`,
      titulo: fase.nome,
      tasks: tasks.filter(
        (x) => x.status !== 'pendente' && x.status !== 'concluida' && x.faseAtual === indice,
      ),
    }))
    const concluidas = tasks.filter((x) => x.status === 'concluida')
    return [
      { id: 'pendentes', titulo: t('esteira.pendentes'), tasks: pendentes },
      ...fases,
      { id: 'concluidas', titulo: t('esteira.concluidas'), tasks: concluidas },
    ]
  }, [tasks, esteira.fases, t])

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={registrarScrollRef}
        onLayout={(e) => registrarViewport(e.nativeEvent.layout.height)}
        onScroll={(e) => registrarScrollOffset(e.nativeEvent.contentOffset.y)}
        scrollEventThrottle={16}
        contentContainerStyle={{ padding: 12, gap: 8, paddingBottom: 96 }}
      >
        {/* Adicionar tarefa — largura total, no topo do board */}
        <Pressable
          onPress={() => router.push(`/(main)/esteira/${esteira.id}/task/nova`)}
          style={[s.novaTaskBtn, { backgroundColor: tokens.primary }]}
        >
          <Plus size={16} color={tokens.primaryForeground} />
          <Text style={[s.novaTaskTexto, { color: tokens.primaryForeground }]}>
            {t('esteira.adicionarTarefa')}
          </Text>
        </Pressable>

        {secoes.map((secao) => {
          const expandida = expandidas[secao.id] ?? true
          return (
            <Secao
              key={secao.id}
              zonaId={secao.id}
              titulo={secao.titulo}
              contador={secao.tasks.length}
              expandida={expandida}
              onToggle={() => alternar(secao.id)}
              onDrop={(task) => aoSoltar(secao.id, task)}
              dropDisabled={arrastando != null && !dropPermitido(secao.id, arrastando)}
              tokens={tokens}
            >
              {secao.tasks.map((task) => (
                <CartaoArrastavel key={task.id} task={task}>
                  <TaskCard
                    task={task}
                    esteira={esteira}
                    progresso={progresso[task.id]}
                    aguardandoTitulo={dependenciaBloqueante(task, tasks)}
                    eProxima={filaLigada && proximaDaFila(task, tasks)}
                    onAbrir={() => abrir(task.id)}
                    onIniciar={() => void iniciarTask(esteira.id, task.id)}
                    onPausar={() => void pausarTask(esteira.id, task.id)}
                    onRetomar={() => void retomarTask(esteira.id, task.id)}
                  />
                </CartaoArrastavel>
              ))}
              {secao.id === 'pendentes' && secao.tasks.length === 0 && (
                <View style={s.pendentesVazio}>
                  <Text style={[s.pendentesVazioTexto, { color: tokens.mutedForeground }]}>
                    {t('esteira.semPendentes')}
                  </Text>
                  <Pressable
                    onPress={() => router.push(`/(main)/esteira/${esteira.id}/task/nova`)}
                    style={[s.pendentesVazioBtn, { borderColor: tokens.border }]}
                  >
                    <Plus size={13} color={tokens.foreground} />
                    <Text style={[s.pendentesVazioBtnTexto, { color: tokens.foreground }]}>
                      {t('esteira.adicionarTarefa')}
                    </Text>
                  </Pressable>
                </View>
              )}
            </Secao>
          )
        })}

        <FooterEsteira tasks={tasks} tokens={tokens} />
      </ScrollView>
    </View>
  )
}

function Secao({
  zonaId,
  titulo,
  contador,
  expandida,
  onToggle,
  onDrop,
  dropDisabled,
  tokens,
  children,
}: {
  zonaId: string
  titulo: string
  contador: number
  expandida: boolean
  onToggle: () => void
  onDrop: (task: Task) => void
  dropDisabled: boolean
  tokens: Record<string, string>
  children: React.ReactNode
}) {
  return (
    <Droppable
      droppableId={zonaId}
      onDrop={onDrop}
      dropDisabled={dropDisabled}
      activeStyle={{ backgroundColor: tokens.accent, borderColor: tokens.primary }}
      style={s.secao}
    >
      <Pressable onPress={onToggle} style={s.secaoHeader}>
        <Text style={[s.secaoTitulo, { color: tokens.foreground }]} numberOfLines={1}>
          {titulo}
        </Text>
        <View style={[s.contador, { backgroundColor: tokens.muted }]}>
          <Text style={[s.contadorTexto, { color: tokens.mutedForeground }]}>{contador}</Text>
        </View>
        {expandida ? (
          <ChevronDown size={15} color={tokens.mutedForeground} />
        ) : (
          <ChevronRight size={15} color={tokens.mutedForeground} />
        )}
      </Pressable>
      {expandida && <View style={{ gap: 6, paddingTop: 6 }}>{children}</View>}
    </Droppable>
  )
}

/** Rodapé do board — espelho do EsteiraFooter do desktop (resumo no app). */
function FooterEsteira({ tasks, tokens }: { tasks: Task[]; tokens: Record<string, string> }) {
  const { t } = useTranslation()
  const resumo = useMemo(() => {
    const commits = new Set<string>()
    let tokensTotal = 0
    let custo = 0
    let tempo = 0
    for (const task of tasks) {
      tokensTotal += task.tokens
      custo += task.custo
      tempo += task.tempoTrabalhoMs
      for (const anotacao of task.anotacoes) {
        if (anotacao.commitHash) commits.add(anotacao.commitHash)
      }
    }
    return {
      concluidas: tasks.filter((x) => x.status === 'concluida').length,
      andamento: tasks.filter((x) => x.status === 'em_progresso').length,
      falhas: tasks.filter((x) => x.pausaMotivo === 'erro').length,
      commits: [...commits],
      tokensTotal,
      custo,
      tempo,
    }
  }, [tasks])

  if (tasks.length === 0) return null

  return (
    <View style={[s.footer, { borderTopColor: tokens.border }]}>
      <View style={s.footerLinha}>
        <CheckCircle2 size={11} color="#10b981" />
        <Text style={[s.footerTexto, { color: tokens.mutedForeground }]}>
          {t('esteira.concluidas')}: {resumo.concluidas}/{tasks.length}
        </Text>
      </View>
      {resumo.andamento > 0 && (
        <View style={s.footerLinha}>
          <Spin>
            <Loader2 size={11} color={tokens.primary} />
          </Spin>
          <Text style={[s.footerTexto, { color: tokens.mutedForeground }]}>
            {t('esteira.emAndamento')}: {resumo.andamento}
          </Text>
        </View>
      )}
      {resumo.falhas > 0 && (
        <View style={s.footerLinha}>
          <AlertTriangle size={11} color={tokens.destructive} />
          <Text style={[s.footerTexto, { color: tokens.mutedForeground }]}>
            {t('esteira.falhas')}: {resumo.falhas}
          </Text>
        </View>
      )}
      {resumo.commits.length > 0 && (
        <View style={s.footerLinha}>
          <GitCommit size={11} color={tokens.mutedForeground} />
          <Text style={[s.footerTexto, { color: tokens.mutedForeground }]}>
            {t('esteira.commits')}:{' '}
            {resumo.commits
              .slice(0, 3)
              .map((h) => h.slice(0, 7))
              .join(', ')}
            {resumo.commits.length > 3 ? '…' : ''}
          </Text>
        </View>
      )}
      {resumo.tempo > 0 && (
        <View style={s.footerLinha}>
          <Clock size={11} color={tokens.mutedForeground} />
          <Text style={[s.footerTexto, { color: tokens.mutedForeground }]}>
            {t('esteira.tempoTotal')}: {formatDuration(resumo.tempo)}
          </Text>
        </View>
      )}
      {resumo.tokensTotal > 0 && (
        <Text style={[s.footerTexto, { color: tokens.mutedForeground }]}>
          {t('esteira.tokens')}: {formatTokens(resumo.tokensTotal)}
        </Text>
      )}
      {resumo.custo > 0 && (
        <Text style={[s.footerTexto, { color: tokens.mutedForeground }]}>
          {t('esteira.custo')}: {formatCost(resumo.custo)}
        </Text>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  novaTaskBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 10,
    paddingVertical: 10,
    marginBottom: 8,
  },
  novaTaskTexto: { fontSize: 13, fontWeight: '600' },
  pendentesVazio: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4 },
  pendentesVazioTexto: { flex: 1, fontSize: 11 },
  pendentesVazioBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pendentesVazioBtnTexto: { fontSize: 12, fontWeight: '500' },
  secao: { borderRadius: 10, borderWidth: 1, borderColor: 'transparent' },
  secaoHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  secaoTitulo: { flex: 1, fontSize: 13, fontWeight: '600' },
  contador: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  contadorTexto: { fontSize: 10, fontWeight: '500' },
  footer: {
    borderTopWidth: 1,
    paddingTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 12,
    rowGap: 4,
  },
  footerLinha: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  footerTexto: { fontSize: 11 },
})
