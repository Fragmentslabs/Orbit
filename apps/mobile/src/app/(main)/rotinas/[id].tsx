/**
 * Detalhe da rotina — espelho do DetalheDaRotina do desktop: header próprio
 * (voltar, título, switch, menu), prompt, badges, "Executar agora" e o
 * histórico de sessões (derivado das sessões com routineId, métricas de runs
 * casadas por sessionId). Tocar numa sessão abre o chat da execução.
 */
import { useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, Alert } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Folder,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react-native'
import { proximaExecucaoDaRotina, ROTINA_MODOS_CHAT } from '@orbit/shared'
import { useSessionStore } from '~/stores/session-store'
import { useRotinasStore } from '~/stores/rotinas-store'
import { useSettingsStore } from '~/stores/settings-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { descreverAgenda } from '~/lib/agenda'
import { formatDateTimeShort } from '~/lib/format-time'
import { formatCost, formatDuration, formatTokens } from '~/lib/format'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { Spin } from '~/components/ui/spin'
import { ActionMenu, type ActionMenuItem } from '~/components/ui/action-menu'
import { AtivaSwitch, ModosBadges } from '~/components/rotinas/agenda-editor'

export default function DetalheDaRotinaScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { t, i18n } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const rotinas = useRotinasStore((s) => s.rotinas)
  const runs = useRotinasStore((s) => s.runs)
  const carregado = useRotinasStore((s) => s.carregado)
  const fetch = useRotinasStore((s) => s.fetch)
  const atualizar = useRotinasStore((s) => s.atualizar)
  const executarAgora = useRotinasStore((s) => s.executarAgora)
  const remover = useRotinasStore((s) => s.remover)
  const sessions = useSessionStore((s) => s.sessions)
  const status = useSessionStore((s) => s.status)
  const catalog = useSettingsStore((s) => s.catalog)

  const [menuAberto, setMenuAberto] = useState(false)

  const rotina = rotinas.find((r) => r.id === id)
  const rodando = runs.some((r) => r.rotinaId === id && r.status === 'rodando')

  useEffect(() => {
    if (!carregado) void fetch()
  }, [carregado, fetch])

  // Rotina removida (aqui ou em outra janela/desktop): volta para a lista em
  // vez de deixar a tela presa num detalhe que não existe mais.
  useEffect(() => {
    if (carregado && !rotina) router.back()
  }, [carregado, rotina, router])

  const execucoes = useMemo(() => {
    if (!rotina) return []
    const metricas = new Map(runs.filter((r) => r.rotinaId === rotina.id).map((r) => [r.sessionId, r]))
    return sessions
      .filter((s) => s.routineId === rotina.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((session) => ({ session, run: metricas.get(session.id) }))
  }, [sessions, runs, rotina])

  if (!rotina) {
    return <SafeScreen style={{ flex: 1 }}>{null}</SafeScreen>
  }

  const proxima = proximaExecucaoDaRotina(rotina)
  const nomeModelo = catalog?.[rotina.modelo.providerId]?.models[rotina.modelo.modelId]?.name ?? rotina.modelo.modelId

  const confirmarExclusao = () => {
    Alert.alert(t('rotinas.lista.excluirTitulo'), t('rotinas.lista.excluirDescricao', { titulo: rotina.titulo }), [
      { text: t('sidebar.cancel'), style: 'cancel' },
      {
        text: t('rotinas.lista.excluir'),
        style: 'destructive',
        onPress: () => {
          void remover(rotina.id).then(() => router.back())
        },
      },
    ])
  }

  const menuItems: ActionMenuItem[] = [
    { icon: Pencil, label: t('rotinas.lista.editar'), onPress: () => router.push(`/(main)/rotinas/editar/${rotina.id}`) },
    { icon: Trash2, label: t('rotinas.lista.excluir'), destructive: true, onPress: confirmarExclusao },
  ]

  return (
    <SafeScreen style={{ flex: 1 }}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <View style={s.headerTitulo}>
          <View style={s.tituloRow}>
            <Text numberOfLines={1} style={[s.titulo, { color: tokens.foreground }]}>
              {rotina.titulo}
            </Text>
            {rodando && (
              <Spin>
                <Loader2 size={14} color={tokens.primary} />
              </Spin>
            )}
          </View>
          <Text numberOfLines={1} style={[s.subtitulo, { color: tokens.mutedForeground }]}>
            {descreverAgenda(rotina.agenda, t)}
            {' · '}
            {proxima
              ? t('rotinas.lista.proxima', { quando: formatDateTimeShort(proxima, i18n.language) })
              : t('rotinas.lista.pausada')}
          </Text>
        </View>
        <AtivaSwitch ativa={rotina.ativa} onChange={(v) => void atualizar(rotina.id, { ativa: v })} />
        <Pressable onPress={() => setMenuAberto(true)} style={s.headerBtn}>
          <MoreHorizontal size={20} color={tokens.mutedForeground} />
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
        {/* Cartão da rotina */}
        <View style={[s.infoCard, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Text style={[s.prompt, { color: tokens.mutedForeground }]}>{rotina.prompt}</Text>
          <View style={s.badgesRow}>
            <ModosBadges
              modos={rotina.modos}
              permissao
              disponiveis={rotina.mode === 'chat' ? ROTINA_MODOS_CHAT : undefined}
            />
            {rotina.mode === 'chat' && (
              <View style={[s.modoBadge, { backgroundColor: tokens.muted }]}>
                <Text style={[s.modoBadgeText, { color: tokens.mutedForeground }]}>{t('rotinas.modo.chat')}</Text>
              </View>
            )}
          </View>
          <Text numberOfLines={1} style={[s.muted, { color: tokens.mutedForeground }]}>
            {nomeModelo}
          </Text>
          {rotina.pastas.length > 0 && (
            <View style={s.pastaRow}>
              <Folder size={13} color={tokens.mutedForeground} />
              <Text numberOfLines={1} style={[s.muted, { color: tokens.mutedForeground, flex: 1 }]}>
                {rotina.pastas.join(', ')}
              </Text>
            </View>
          )}
        </View>

        {/* Executar agora */}
        <Pressable
          onPress={() => void executarAgora(rotina.id)}
          disabled={rodando}
          style={[
            s.executarBtn,
            { borderColor: tokens.border },
            rodando && { opacity: 0.4 },
          ]}
        >
          {rodando ? (
            <Spin>
              <Loader2 size={15} color={tokens.foreground} />
            </Spin>
          ) : (
            <Play size={15} color={tokens.foreground} />
          )}
          <Text style={[s.executarBtnText, { color: tokens.foreground }]}>{t('rotinas.lista.executarAgora')}</Text>
        </Pressable>

        {/* Histórico de execuções */}
        <Text style={[s.runsTitulo, { color: tokens.foreground }]}>{t('rotinas.runs.titulo')}</Text>

        {execucoes.length === 0 ? (
          <Text style={[s.muted, { color: tokens.mutedForeground }]}>{t('rotinas.runs.vazio')}</Text>
        ) : (
          execucoes.map(({ session, run }) => {
            const statusSessao = status[session.id]
            const rodandoRun = statusSessao === 'submitted' || statusSessao === 'streaming' || run?.status === 'rodando'
            const statusRun = rodandoRun ? 'rodando' : run?.status === 'erro' || statusSessao === 'error' ? 'erro' : 'ok'
            const duracao =
              run?.concluidoEm && run.iniciadoEm ? formatDuration(run.concluidoEm - run.iniciadoEm) : undefined

            return (
              <Pressable
                key={session.id}
                onPress={() => router.push({ pathname: '/(main)/chat/[id]', params: { id: session.id } })}
                style={[s.runRow, { borderColor: tokens.border, backgroundColor: tokens.card }]}
              >
                {statusRun === 'rodando' ? (
                  <Spin>
                    <Loader2 size={14} color={tokens.primary} />
                  </Spin>
                ) : statusRun === 'erro' ? (
                  <AlertCircle size={14} color={tokens.destructive} />
                ) : (
                  <CheckCircle2 size={14} color={tokens.mutedForeground} />
                )}
                <View style={{ minWidth: 0, flex: 1 }}>
                  <Text numberOfLines={1} style={[s.runData, { color: tokens.foreground }]}>
                    {formatDateTimeShort(run?.iniciadoEm ?? session.createdAt, i18n.language)}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[s.runStatus, { color: statusRun === 'erro' ? tokens.destructive : tokens.mutedForeground }]}
                  >
                    {statusRun === 'rodando'
                      ? t('rotinas.runs.rodando')
                      : statusRun === 'erro'
                        ? run?.erro || t('rotinas.runs.erro')
                        : [duracao, run && run.tokens > 0 ? t('rotinas.runs.tokens', { valor: formatTokens(run.tokens) }) : null, run && run.custo > 0 ? formatCost(run.custo) : null]
                            .filter(Boolean)
                            .join(' · ') || t('rotinas.runs.ok')}
                  </Text>
                </View>
                <View style={s.abrirRow}>
                  <Text style={[s.abrirText, { color: tokens.mutedForeground }]}>{t('rotinas.runs.abrirChat')}</Text>
                  <ExternalLink size={12} color={tokens.mutedForeground} />
                </View>
              </Pressable>
            )
          })
        )}
      </ScrollView>

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
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitulo: { minWidth: 0, flex: 1 },
  tituloRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  titulo: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  subtitulo: { fontSize: 12, marginTop: 1 },

  infoCard: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 8 },
  prompt: { fontSize: 12, lineHeight: 17 },
  badgesRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  modoBadge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  modoBadgeText: { fontSize: 11, fontWeight: '500' },
  muted: { fontSize: 12 },
  pastaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  executarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 11,
  },
  executarBtnText: { fontSize: 13, fontWeight: '600' },

  runsTitulo: { fontSize: 14, fontWeight: '600', marginTop: 4 },
  runRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  runData: { fontSize: 13 },
  runStatus: { fontSize: 12, marginTop: 1 },
  abrirRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
  abrirText: { fontSize: 12 },
})
