/**
 * Card da task no board — espelho do TaskCard do desktop: título com botão de
 * ação (pausar/iniciar/retomar, ícone cinza), chips de estado translúcidos
 * (bg-primary/10 etc.) e feed ao vivo do final do texto da fase em execução.
 */
import { memo } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Clock, Loader2, Pause, Play } from 'lucide-react-native'
import type { Esteira, Task } from '@orbit/shared'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { formatDuration, formatTokens } from '~/lib/format'
import { Spin } from '~/components/ui/spin'

export const TaskCard = memo(function TaskCard({
  task,
  esteira,
  progresso,
  aguardandoTitulo,
  eProxima,
  onAbrir,
  onIniciar,
  onPausar,
  onRetomar,
  esmaecido,
}: {
  task: Task
  esteira: Esteira
  progresso?: string
  /** Título da dependência que bloqueia a task. */
  aguardandoTitulo?: string
  eProxima?: boolean
  onAbrir: () => void
  onIniciar: () => void
  onPausar: () => void
  onRetomar: () => void
  /** Dim quando o card é a origem de um arrasto em andamento. */
  esmaecido?: boolean
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const escuro = useThemeStore((s) => s.resolved) === 'dark'

  const emExecucao = task.status === 'em_progresso'
  const comErro = task.pausaMotivo === 'erro'
  const faseNome = task.faseAtual != null ? (esteira.fases[task.faseAtual]?.nome ?? '') : undefined

  // Chips com fundo (iguais ao desktop: translúcidos) vs. extras em texto puro
  // (tempo, tokens, dependências — sem fundo no desktop).
  const chips: { key: string; icon?: 'clock' | 'play' | 'pause' | 'alert'; texto: string; cor: 'primary' | 'destructive' | 'warning' | 'muted' }[] = []
  const extras: { key: string; icon?: 'clock'; texto: string }[] = []

  if (aguardandoTitulo) chips.push({ key: 'aguardando', icon: 'clock', texto: t('esteira.aguardando', { titulo: aguardandoTitulo }), cor: 'muted' })
  if (eProxima) chips.push({ key: 'proxima', icon: 'play', texto: t('esteira.proxima'), cor: 'primary' })
  if (emExecucao && faseNome) chips.push({ key: 'fase', icon: 'play', texto: faseNome, cor: 'primary' })
  if (comErro) chips.push({ key: 'erro', icon: 'alert', texto: t('esteira.erro'), cor: 'destructive' })
  if (task.pushFalha) chips.push({ key: 'push', icon: 'alert', texto: t('esteira.pushFalhou'), cor: 'warning' })
  if (task.status === 'pausada' && !comErro) chips.push({ key: 'pausada', icon: 'pause', texto: faseNome ?? t('esteira.pausada'), cor: 'muted' })
  if (task.tempoTrabalhoMs > 0) extras.push({ key: 'tempo', icon: 'clock', texto: formatDuration(task.tempoTrabalhoMs) })
  if (task.tokens > 0) extras.push({ key: 'tokens', texto: `${formatTokens(task.tokens)} tok` })
  if (task.dependeDe.length > 0) extras.push({ key: 'deps', texto: `· ${t('esteira.dependencias', { count: task.dependeDe.length })}` })

  const corChip = (cor: 'primary' | 'destructive' | 'warning' | 'muted'): { fundo: string; texto: string } => {
    if (cor === 'primary') return { fundo: withAlpha(tokens.primary, 0.1), texto: tokens.primary }
    if (cor === 'destructive') return { fundo: withAlpha(tokens.destructive, 0.1), texto: tokens.destructive }
    if (cor === 'warning') return { fundo: withAlpha('#eab308', 0.15), texto: escuro ? '#facc15' : '#ca8a04' }
    return { fundo: tokens.muted, texto: tokens.mutedForeground }
  }

  return (
    <View
      style={[
        s.card,
        {
          backgroundColor: tokens.card,
          borderColor: comErro ? withAlpha(tokens.destructive, 0.5) : tokens.border,
          opacity: esmaecido ? 0.4 : 1,
        },
      ]}
    >
      <View style={s.linhaTitulo}>
        <Pressable onPress={onAbrir} style={{ minWidth: 0, flex: 1 }}>
          <Text style={[s.titulo, { color: tokens.foreground }]} numberOfLines={1}>
            {task.titulo}
          </Text>
        </Pressable>
        {emExecucao ? (
          <Pressable onPress={onPausar} hitSlop={8} accessibilityLabel={t('esteira.pausar')} style={s.botaoAcao}>
            <Pause size={13} color={tokens.mutedForeground} />
          </Pressable>
        ) : task.status === 'pausada' ? (
          <Pressable onPress={onRetomar} hitSlop={8} accessibilityLabel={t('esteira.retomar')} style={s.botaoAcao}>
            <Play size={13} color={tokens.mutedForeground} />
          </Pressable>
        ) : task.status === 'pendente' ? (
          <Pressable onPress={onIniciar} hitSlop={8} accessibilityLabel={t('esteira.iniciar')} style={s.botaoAcao}>
            <Play size={13} color={tokens.mutedForeground} />
          </Pressable>
        ) : null}
      </View>

      <View style={s.badges}>
        {chips.map((chip) => {
          const cor = corChip(chip.cor)
          return (
            <View key={chip.key} style={[s.chip, { backgroundColor: cor.fundo }]}>
              {chip.icon === 'clock' && <Clock size={10} color={cor.texto} />}
              {chip.icon === 'play' && !emExecucao && <Play size={10} color={cor.texto} />}
              {chip.icon === 'pause' && <Pause size={10} color={cor.texto} />}
              {chip.icon === 'alert' && <AlertTriangle size={10} color={cor.texto} />}
              {chip.key === 'fase' && emExecucao && (
                <Spin>
                  <Loader2 size={10} color={cor.texto} />
                </Spin>
              )}
              <Text style={[s.chipTexto, { color: cor.texto }]} numberOfLines={1}>
                {chip.texto}
              </Text>
            </View>
          )
        })}
        {extras.map((x) => (
          <View key={x.key} style={s.extra}>
            {x.icon === 'clock' && <Clock size={10} color={tokens.mutedForeground} />}
            <Text style={[s.chipTexto, { color: tokens.mutedForeground }]} numberOfLines={1}>
              {x.texto}
            </Text>
          </View>
        ))}
      </View>

      {emExecucao && progresso ? (
        <Text style={[s.feed, { color: withAlpha(tokens.mutedForeground, 0.8) }]} numberOfLines={2}>
          {progresso.slice(-160)}
        </Text>
      ) : null}
    </View>
  )
})

const s = StyleSheet.create({
  card: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
    gap: 6,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  linhaTitulo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titulo: { flex: 1, fontSize: 12, fontWeight: '500' },
  botaoAcao: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    maxWidth: '100%',
  },
  extra: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chipTexto: { fontSize: 10, fontWeight: '500' },
  feed: { fontSize: 10, lineHeight: 14 },
})
