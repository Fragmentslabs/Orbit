/**
 * Detalhe da task — espelho do TaskModal do desktop como tela: banners de
 * erro/push, título e descrição editáveis (salvam no blur), tabs de fase com
 * anotação markdown e execução ao vivo, telemetria, dependências e ações
 * (iniciar/pausar/retomar/excluir).
 */
import { useMemo, useState } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, Alert, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AlertTriangle, Check, Loader2, Pause, Play, Search, Terminal, Trash2, X } from 'lucide-react-native'
import type { AnotacaoFase, Esteira, Task } from '@orbit/shared'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Badge } from '~/components/ui/badge'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { Spin } from '~/components/ui/spin'
import { AssistantMarkdown } from '~/components/chat/AssistantMarkdown'
import { Shimmer } from '~/components/ai/Shimmer'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useEsteiraStore } from '~/stores/esteira-store'
import { formatCost, formatDuration, formatTokens } from '~/lib/format'
import { formatDateTimeShort } from '~/lib/format-time'

export function TaskDetail({
  esteira,
  task,
  onFechar,
}: {
  esteira: Esteira
  task: Task
  /** Chamado depois de excluir (volta para o board). */
  onFechar: () => void
}) {
  const { t, i18n } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()

  const tasks = useEsteiraStore((s) => s.tasksPorEsteira[esteira.id] ?? [])
  const atualizarTask = useEsteiraStore((s) => s.atualizarTask)
  const removerTask = useEsteiraStore((s) => s.removerTask)
  const iniciarTask = useEsteiraStore((s) => s.iniciarTask)
  const pausarTask = useEsteiraStore((s) => s.pausarTask)
  const retomarTask = useEsteiraStore((s) => s.retomarTask)

  // Estado inicial dos props: a rota monta com key={task.id}, então trocar de
  // task remonta e zera tudo (sem efeito de reset).
  const [titulo, setTitulo] = useState(task.titulo)
  const [descricao, setDescricao] = useState(task.descricao)
  const [faseAtiva, setFaseAtiva] = useState(task.faseAtual ?? 0)
  const [seletorDeps, setSeletorDeps] = useState(false)
  const [erroDep, setErroDep] = useState<string | null>(null)

  const comErro = task.pausaMotivo === 'erro'
  const emExecucao = task.status === 'em_progresso'

  const salvarCampo = async (patch: Partial<Pick<Task, 'titulo' | 'descricao'>>) => {
    try {
      await atualizarTask(esteira.id, task.id, patch)
    } catch {
      // Sem edição otimista: o evento do main volta com o valor confirmado.
    }
  }

  const anotacaoPorFase = useMemo(() => {
    const mapa = new Map<string, AnotacaoFase>()
    for (const anotacao of task.anotacoes) mapa.set(anotacao.faseId, anotacao)
    return mapa
  }, [task.anotacoes])

  const anotacao = anotacaoPorFase.get(esteira.fases[faseAtiva]?.id ?? '')

  const alterarDependencias = async (proximas: string[]) => {
    try {
      await atualizarTask(esteira.id, task.id, { dependeDe: proximas })
      setErroDep(null)
    } catch (err) {
      setErroDep(err instanceof Error ? err.message : String(err))
    }
  }

  const confirmarExclusao = () => {
    Alert.alert(
      t('esteira.confirmarExclusaoTask', { titulo: task.titulo }),
      t('esteira.exclusaoTaskDescricao'),
      [
        { text: t('sidebar.cancel'), style: 'cancel' },
        {
          text: t('esteira.excluirTask'),
          style: 'destructive',
          onPress: () => {
            void removerTask(esteira.id, task.id).then(onFechar)
          },
        },
      ],
    )
  }

  const linhasDiff = useMemo(() => {
    if (!task.diff?.patch) return { mais: 0, menos: 0 }
    let mais = 0
    let menos = 0
    for (const linha of task.diff.patch.split('\n')) {
      if (linha.startsWith('+++') || linha.startsWith('---')) continue
      if (linha.startsWith('+')) mais++
      else if (linha.startsWith('-')) menos++
    }
    return { mais, menos }
  }, [task.diff])

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 96 + insets.bottom }}>
        {comErro && (
          <View style={[s.banner, { backgroundColor: tokens.muted, borderColor: tokens.destructive }]}>
            <AlertTriangle size={16} color={tokens.destructive} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={[s.bannerTitulo, { color: tokens.destructive }]}>{t('esteira.pausadaPorErro')}</Text>
              {!!task.erro && (
                <Text style={[s.bannerTexto, { color: tokens.mutedForeground }]} numberOfLines={3}>
                  {task.erro}
                </Text>
              )}
            </View>
            <Pressable onPress={() => void retomarTask(esteira.id, task.id)} style={[s.bannerBotao, { backgroundColor: tokens.primary }]}>
              <Text style={[s.bannerBotaoTexto, { color: tokens.primaryForeground }]}>{t('esteira.retomar')}</Text>
            </Pressable>
          </View>
        )}

        {!!task.pushFalha && (
          <View style={[s.banner, { backgroundColor: tokens.muted, borderColor: '#eab308' }]}>
            <AlertTriangle size={16} color="#eab308" />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={[s.bannerTitulo, { color: tokens.foreground }]}>{t('esteira.pushFalhou')}</Text>
              <Text style={[s.bannerTexto, { color: tokens.mutedForeground }]} numberOfLines={3}>
                {task.pushFalha}
              </Text>
            </View>
          </View>
        )}

        {/* Título editável + badge de status */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Input
            value={titulo}
            onChangeText={setTitulo}
            onBlur={() => titulo.trim() !== task.titulo && titulo.trim() && void salvarCampo({ titulo: titulo.trim() })}
            style={{ flex: 1 }}
          />
          <Badge variant="secondary">{t(`esteira.status.${task.status}`)}</Badge>
        </View>

        {task.diff && task.diff.arquivos.length > 0 && (
          <Text style={[s.info, { color: tokens.mutedForeground }]}>
            {t('esteira.arquivosAlterados', { count: task.diff.arquivos.length })}
            {linhasDiff.mais > 0 && <Text style={{ color: '#10b981' }}> +{linhasDiff.mais}</Text>}
            {linhasDiff.menos > 0 && <Text style={{ color: tokens.destructive }}> -{linhasDiff.menos}</Text>}
          </Text>
        )}

        {/* Descrição editável */}
        <View style={{ gap: 5 }}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.descricao')}</Text>
          <Textarea
            value={descricao}
            onChangeText={setDescricao}
            onBlur={() => descricao !== task.descricao && void salvarCampo({ descricao })}
            style={{ minHeight: 72, maxHeight: 200 }}
          />
        </View>

        {/* Tabs de fases — underline como no desktop (border-b-2), não pills */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ borderBottomWidth: 1, borderBottomColor: tokens.border }}
          contentContainerStyle={{ gap: 4, paddingHorizontal: 2 }}
        >
          {esteira.fases.map((fase, indice) => {
            const anotacaoFase = anotacaoPorFase.get(fase.id)
            const ativa = faseAtiva === indice
            const rodando = emExecucao && task.faseAtual === indice
            return (
              <Pressable
                key={fase.id}
                onPress={() => setFaseAtiva(indice)}
                style={[s.tab, { borderBottomColor: ativa ? tokens.primary : 'transparent' }]}
              >
                {anotacaoFase?.status === 'ok' && <Check size={12} color="#10b981" />}
                {anotacaoFase?.status === 'erro' && <AlertTriangle size={12} color={tokens.destructive} />}
                {anotacaoFase?.status === 'pulada' && (
                  <Text style={[s.tabPulada, { color: tokens.mutedForeground }]}>↷</Text>
                )}
                {rodando && (
                  <View style={[s.tabPonto, { backgroundColor: tokens.primary }]} />
                )}
                <Text
                  style={[s.tabTexto, { color: ativa ? tokens.foreground : tokens.mutedForeground }]}
                  numberOfLines={1}
                >
                  {fase.nome}
                </Text>
              </Pressable>
            )
          })}
        </ScrollView>

        {/* Painel da fase */}
        {emExecucao && task.faseAtual === faseAtiva ? (
          <ExecucaoViva taskId={task.id} faseIndice={faseAtiva} />
        ) : anotacao ? (
          <View style={{ gap: 8 }}>
            <AssistantMarkdown text={anotacao.conteudo} />
            {anotacao.comandosControlados.length > 0 && (
              <View style={[s.comandos, { backgroundColor: tokens.muted }]}>
                <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.comandosControlados')}</Text>
                {anotacao.comandosControlados.map((cmd, i) => (
                  <Text key={i} style={[s.comando, { color: tokens.mutedForeground }]}>
                    {cmd}
                  </Text>
                ))}
              </View>
            )}
          </View>
        ) : (
          <Text style={[s.info, { color: tokens.mutedForeground }]}>{t('esteira.semAnotacao')}</Text>
        )}

        {/* Telemetria */}
        <View style={[s.telemetria, { borderTopColor: tokens.border }]}>
          <LinhaTelemetria rotulo={t('esteira.criadaEm')} valor={formatDateTimeShort(new Date(task.criadoEm).getTime(), i18n.language)} tokens={tokens} />
          <LinhaTelemetria rotulo={t('esteira.concluidaEm')} valor={task.concluidoEm ? formatDateTimeShort(new Date(task.concluidoEm).getTime(), i18n.language) : '—'} tokens={tokens} />
          <LinhaTelemetria rotulo={t('esteira.tempoTrabalho')} valor={formatDuration(task.tempoTrabalhoMs)} tokens={tokens} />
          <LinhaTelemetria rotulo={t('esteira.tokens')} valor={formatTokens(task.tokens)} tokens={tokens} />
          <LinhaTelemetria rotulo={t('esteira.custo')} valor={formatCost(task.custo)} tokens={tokens} />
        </View>

        {/* Dependências */}
        <View style={{ gap: 6 }}>
          <Text style={[s.rotulo, { color: tokens.foreground }]}>{t('esteira.dependenciasTitulo')}</Text>
          {task.dependeDe.length === 0 ? (
            <Text style={[s.info, { color: tokens.mutedForeground }]}>{t('esteira.semDependencias')}</Text>
          ) : (
            task.dependeDe.map((id) => {
              const dep = tasks.find((x) => x.id === id)
              if (!dep) return null
              return (
                <View key={id} style={[s.depLinha, { borderColor: tokens.border }]}>
                  <View style={[s.depPonto, { backgroundColor: dep.status === 'concluida' ? '#10b981' : '#eab308' }]} />
                  <Text style={[s.depTitulo, { color: tokens.foreground }]} numberOfLines={1}>
                    {dep.titulo}
                  </Text>
                  <Pressable onPress={() => void alterarDependencias(task.dependeDe.filter((x) => x !== id))} hitSlop={8}>
                    <X size={13} color={tokens.mutedForeground} />
                  </Pressable>
                </View>
              )
            })
          )}
          <Pressable onPress={() => setSeletorDeps(true)} style={{ alignSelf: 'flex-start' }}>
            <Text style={[s.info, { color: tokens.primary }]}>+ {t('esteira.adicionarDependencia')}</Text>
          </Pressable>
          {erroDep && <Text style={[s.erro, { color: tokens.destructive }]}>{erroDep}</Text>}
        </View>
      </ScrollView>

      {/* Rodapé de ações — afastado da base pelo safe area */}
      <View
        style={[
          s.acoes,
          { borderTopColor: tokens.border, backgroundColor: tokens.background, paddingBottom: 12 + insets.bottom },
        ]}
      >
        {task.status !== 'concluida' && (
          <Pressable
            onPress={() => {
              if (task.status === 'em_progresso') void pausarTask(esteira.id, task.id)
              else if (task.status === 'pausada') void retomarTask(esteira.id, task.id)
              else void iniciarTask(esteira.id, task.id)
            }}
            style={[s.acaoPrimaria, { backgroundColor: tokens.primary }]}
          >
            {emExecucao ? (
              <Pause size={16} color={tokens.primaryForeground} />
            ) : (
              <Play size={16} color={tokens.primaryForeground} />
            )}
            <Text style={[s.acaoPrimariaTexto, { color: tokens.primaryForeground }]}>
              {emExecucao ? t('esteira.pausar') : task.status === 'pausada' ? t('esteira.retomar') : t('esteira.iniciar')}
            </Text>
          </Pressable>
        )}
        <Pressable onPress={confirmarExclusao} style={[s.acaoExcluir, { borderColor: tokens.border }]}>
          <Trash2 size={15} color={tokens.destructive} />
        </Pressable>
      </View>

      {seletorDeps && (
        <SeletorDependencias
          onFechar={() => setSeletorDeps(false)}
          tasks={tasks.filter((x) => x.id !== task.id)}
          selecionadas={task.dependeDe}
          onMudar={(ids) => void alterarDependencias(ids)}
        />
      )}
    </View>
  )
}

function LinhaTelemetria({ rotulo, valor, tokens }: { rotulo: string; valor: string; tokens: Record<string, string> }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Text style={[s.info, { color: tokens.mutedForeground }]}>{rotulo}</Text>
      <Text style={[s.info, { color: tokens.foreground }]} numberOfLines={1}>
        {valor}
      </Text>
    </View>
  )
}

/** Execução ao vivo da fase — mesmo vocabulário visual do chat do desktop:
 *  pensamento em streaming + tools com estado. */
function ExecucaoViva({ taskId, faseIndice }: { taskId: string; faseIndice: number }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const atividade = useEsteiraStore((s) => s.atividade[taskId])
  const atual = atividade && atividade.faseIndice === faseIndice ? atividade : undefined

  if (!atual) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Spin>
          <Loader2 size={13} color={tokens.primary} />
        </Spin>
        <Text style={[s.info, { color: tokens.mutedForeground }]}>{t('esteira.iniciando')}</Text>
      </View>
    )
  }

  const vazio = atual.pensando.length === 0 && atual.tools.length === 0

  return (
    <View style={{ gap: 8 }}>
      <View style={[s.executandoChip, { borderColor: tokens.primary }]}>
        <Shimmer className="text-xs font-semibold">{t('esteira.executando')}</Shimmer>
        <Spin>
          <Loader2 size={12} color={tokens.primary} />
        </Spin>
      </View>

      {vazio && (
        <Text style={[s.info, { color: tokens.mutedForeground }]}>{t('esteira.iniciando')}</Text>
      )}

      {!!atual.pensando && (
        <View style={{ gap: 4 }}>
          <Shimmer className="text-xs font-semibold">{t('chatAssistant.reasoning')}</Shimmer>
          <AssistantMarkdown text={atual.pensando} streaming muted size={12} />
        </View>
      )}

      {atual.tools.map((tool) => (
        <View key={tool.toolCallId} style={{ gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {tool.estado === 'rodando' ? (
              <ActivityIndicator size="small" color={tokens.primary} />
            ) : tool.estado === 'erro' ? (
              <AlertTriangle size={13} color={tokens.destructive} />
            ) : (
              <Terminal size={13} color={tokens.mutedForeground} />
            )}
            {tool.estado === 'rodando' ? (
              <Shimmer className="text-xs font-semibold">{tool.tool}</Shimmer>
            ) : (
              <Text style={[s.toolNome, { color: tool.estado === 'erro' ? tokens.destructive : tokens.foreground }]}>
                {tool.tool}
              </Text>
            )}
          </View>
          {!!tool.resumo && (
            <Text style={[s.info, { color: tokens.mutedForeground }]} numberOfLines={3}>
              {tool.resumo}
            </Text>
          )}
          {tool.estado === 'erro' && !!tool.detalhe && (
            <Text style={[s.info, { color: tokens.destructive }]} numberOfLines={3}>
              {tool.detalhe}
            </Text>
          )}
        </View>
      ))}
    </View>
  )
}

/** Seletor de dependências — BottomSheet grande com busca no topo e lista
 *  abaixo, igual ao popover do desktop: as escolhas aplicam ao vivo (sem
 *  botões de confirmar) e fecha ao tocar fora. Montado condicionalmente pelo
 *  pai: o estado inicial vem dos props. */
export function SeletorDependencias({
  onFechar,
  tasks,
  selecionadas,
  onMudar,
}: {
  onFechar: () => void
  tasks: Task[]
  selecionadas: string[]
  onMudar: (ids: string[]) => void
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [busca, setBusca] = useState('')
  const [escolhidas, setEscolhidas] = useState<string[]>(selecionadas)

  const filtradas = tasks.filter((x) => x.titulo.toLowerCase().includes(busca.trim().toLowerCase()))

  const alternar = (id: string) => {
    const proximas = escolhidas.includes(id)
      ? escolhidas.filter((x) => x !== id)
      : [...escolhidas, id]
    setEscolhidas(proximas)
    onMudar(proximas)
  }

  return (
    <BottomSheet
      aberto
      aoFechar={onFechar}
      titulo={
        <Text style={[s.sheetTitulo, { color: tokens.foreground }]}>{t('esteira.taskDependencias')}</Text>
      }
    >
      <View style={[s.buscaBox, { borderColor: tokens.border }]}>
        <Search size={14} color={tokens.mutedForeground} />
        <Input
          value={busca}
          onChangeText={setBusca}
          placeholder={t('esteira.buscarTask')}
          autoFocus
          style={{ flex: 1, borderWidth: 0, height: 34, paddingHorizontal: 0 }}
        />
      </View>
      <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
        {filtradas.length === 0 ? (
          <Text style={[s.info, { color: tokens.mutedForeground, textAlign: 'center', paddingVertical: 14 }]}>
            {t('esteira.nenhumaTask')}
          </Text>
        ) : (
          filtradas.map((x) => {
            const marcada = escolhidas.includes(x.id)
            return (
              <Pressable key={x.id} onPress={() => alternar(x.id)} style={s.depOpcao}>
                <View
                  style={[
                    s.depCheckbox,
                    { borderColor: marcada ? tokens.primary : tokens.border },
                    marcada && { backgroundColor: tokens.primary },
                  ]}
                >
                  {marcada && <Check size={10} color={tokens.primaryForeground} />}
                </View>
                <Text style={[s.depOpcaoTitulo, { color: tokens.foreground }]} numberOfLines={1}>
                  {x.titulo}
                </Text>
                <Text style={[s.info, { color: tokens.mutedForeground }]}>
                  {t(`esteira.status.${x.status}`)}
                </Text>
              </Pressable>
            )
          })
        )}
      </ScrollView>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 10, borderWidth: 1, padding: 10 },
  bannerTitulo: { fontSize: 12, fontWeight: '600' },
  bannerTexto: { fontSize: 11, lineHeight: 15 },
  bannerBotao: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  bannerBotaoTexto: { fontSize: 12, fontWeight: '600' },
  info: { fontSize: 11 },
  rotulo: { fontSize: 12, fontWeight: '600' },
  erro: { fontSize: 11 },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderBottomWidth: 2,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxWidth: 170,
  },
  tabTexto: { fontSize: 12, fontWeight: '500' },
  tabPulada: { fontSize: 12 },
  tabPonto: { width: 6, height: 6, borderRadius: 3 },
  comandos: { borderRadius: 8, padding: 10, gap: 4 },
  comando: { fontFamily: 'monospace', fontSize: 11 },
  telemetria: { borderTopWidth: 1, paddingTop: 10, gap: 4 },
  depLinha: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  depPonto: { width: 7, height: 7, borderRadius: 4 },
  depTitulo: { flex: 1, fontSize: 12 },
  acoes: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 10,
    borderTopWidth: 1,
    padding: 12,
  },
  acaoPrimaria: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    paddingVertical: 11,
  },
  acaoPrimariaTexto: { fontSize: 14, fontWeight: '600' },
  acaoExcluir: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 16,
  },
  executandoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  toolNome: { fontSize: 12, fontWeight: '600' },
  buscaBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
  },
  depOpcao: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderRadius: 8,
  },
  depOpcaoTitulo: { flex: 1, fontSize: 13 },
  depCheckbox: {
    width: 15,
    height: 15,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetTitulo: { fontSize: 15, fontWeight: '600', marginBottom: 10 },
})
